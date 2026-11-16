#pragma once
#include "libslic3r/Config.hpp"
#include "libslic3r/Nonplanar/HeadEnvelope.hpp"
#include "libslic3r/Nonplanar/Validate.hpp"
#include "libslic3r/Preset.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/PrintConfig.hpp"
#include <boost/filesystem/operations.hpp>
#include <boost/filesystem/path.hpp>
#include <boost/nowide/fstream.hpp>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <initializer_list>
#include <ios>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
namespace {
void write_catalog(const std::string &path, const nlohmann::json &catalog)
{
    boost::nowide::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << catalog.dump(2) << '\n';
    out.close();
    if (!out) throw std::runtime_error("cannot write catalog " + path);
}

std::string option_type_name(ConfigOptionType type)
{
    switch (type) {
    case coNone: return "none";
    case coFloat: return "float"; case coFloats: return "floats";
    case coInt: return "int"; case coInts: return "ints";
    case coString: return "string"; case coStrings: return "strings";
    case coPercent: return "percent"; case coPercents: return "percents";
    case coFloatOrPercent: return "float_or_percent"; case coFloatsOrPercents: return "floats_or_percents";
    case coPoint: return "point"; case coPoints: return "points"; case coPoint3: return "point3";
    case coBool: return "bool"; case coBools: return "bools";
    case coEnum: return "enum"; case coEnums: return "enums";
    case coPointsGroups: return "points_groups"; case coIntsGroups: return "ints_groups";
    default: return "unknown";
    }
}
void dump_options(const std::string &path)
{
    nlohmann::json options = nlohmann::json::array();
    for (const auto &[key, def] : print_config_def.options) {
        options.push_back({{"key", key}, {"type", option_type_name(def.type)}, {"type_id", int(def.type)},
            {"label", def.label}, {"full_label", def.full_label}, {"tooltip", def.tooltip},
            {"category", def.category}, {"sidetext", def.sidetext}, {"enum_values", def.enum_values},
            {"enum_labels", def.enum_labels}, {"min", def.min}, {"max", def.max}, {"mode", int(def.mode)},
            {"default", def.default_value ? def.default_value->serialize() : ""},
            {"nullable", def.nullable}, {"readonly", def.readonly}, {"cli", def.cli}});
        if (key == "nonplanar_curved_max_angle") {
            nlohmann::json by_mode = nlohmann::json::object();
            for (const auto &[name, value] : ConfigOptionEnum<NonplanarMode>::get_enum_values())
                if (const double limit = Nonplanar::curved_max_angle_limit(NonplanarMode(value)); limit > 0.)
                    by_mode[name] = limit;
            options.back()["max_by_mode"] = by_mode;
        }
    }
    write_catalog(path, {{"schema", "orca.options.v1"}, {"options", options}});
}

nlohmann::json read_catalog_json(const fs::path &path)
{
    boost::nowide::ifstream in(path.string());
    if (!in) throw std::runtime_error("cannot read " + path.string());
    return nlohmann::json::parse(in);
}

void dump_presets(const Args &args)
{
    PresetBundle library, bundle;
    const auto rule = ForwardCompatibilitySubstitutionRule::EnableSilent;
    if (fs::is_regular_file(fs::path(args.profiles) / "OrcaFilamentLibrary.json"))
        library.load_vendor_configs_from_json(args.profiles, "OrcaFilamentLibrary", PresetBundle::LoadSystem, rule, nullptr, false);
    bundle.load_vendor_configs_from_json(args.profiles, args.vendor, PresetBundle::LoadSystem, rule,
        args.vendor == "OrcaFilamentLibrary" ? nullptr : &library, false);
    if (library.error_count() || bundle.error_count()) throw std::runtime_error("invalid vendor preset bundle");
    const auto manifest = read_catalog_json(fs::path(args.profiles) / (args.vendor + ".json"));
    std::map<std::string, nlohmann::json> sources;
    auto collect = [&](const std::string &vendor) {
        const auto index = read_catalog_json(fs::path(args.profiles) / (vendor + ".json"));
        for (const char *list : {"machine_list", "process_list", "filament_list"})
            if (index.contains(list)) for (const auto &entry : index.at(list)) {
                auto source = read_catalog_json(fs::path(args.profiles) / vendor / entry.at("sub_path").get<std::string>());
                std::string name = source.at("name").get<std::string>();
                sources[std::move(name)] = std::move(source);
            }
    };
    if (fs::is_regular_file(fs::path(args.profiles) / "OrcaFilamentLibrary.json")) collect("OrcaFilamentLibrary");
    collect(args.vendor);
    nlohmann::json catalog = {{"schema", "orca.presets.v1"}, {"vendor", args.vendor},
        {"name", manifest.value("name", args.vendor)}, {"version", manifest.value("version", "")},
        {"machine", nlohmann::json::array()}, {"process", nlohmann::json::array()},
        {"filament", nlohmann::json::array()}, {"printer_models", nlohmann::json::array()}};
    for (const auto &[kind, collection] : std::initializer_list<std::pair<const char *, const PresetCollection *>>{
            {"machine", &bundle.printers}, {"process", &bundle.prints}, {"filament", &bundle.filaments}}) {
        for (const Preset &preset : collection->get_presets()) {
            if (preset.is_default) continue;
            nlohmann::json values = nlohmann::json::object(), chain = nlohmann::json::array();
            for (const auto &key : preset.config.keys()) values[key] = preset.config.opt_serialize(key);
            auto source = sources.find(preset.name);
            std::string parent = source == sources.end() ? preset.inherits() : source->second.value("inherits", "");
            std::vector<std::string> seen;
            while (!parent.empty()) {
                if (std::find(seen.begin(), seen.end(), parent) != seen.end()) throw std::runtime_error("cyclic preset chain " + parent);
                seen.push_back(parent); chain.push_back(parent);
                const auto it = sources.find(parent);
                if (it == sources.end()) throw std::runtime_error("missing preset parent " + parent);
                parent = it->second.value("inherits", "");
            }
            nlohmann::json entry = {{"name", preset.name}, {"type", kind}, {"inherits", chain},
                {"visible", preset.is_visible}, {"instantiation", true}, {"values", values},
                {"compatible_printers", values.value("compatible_printers", "")},
                {"compatible_printers_condition", values.value("compatible_printers_condition", "")}};
            if (collection == &bundle.printers) {
                PrintConfig printer;
                printer.apply(preset.config, true);
                entry["native_support_capable"] = Nonplanar::native_support_capable(printer);
            }
            if (collection == &bundle.filaments) {
                entry["filament_id"] = preset.filament_id;
                entry["setting_id"] = preset.setting_id;
            }
        }
        const Source *first = tunings.front();
        from = {{"rule", "first"}, {"vendor", first->vendor}, {"name", first->name}};
        ++rules["first"];
        first_bases.push_back(id + " (" + first->vendor + "/" + first->name + ")");
        return first->values;
    }
    nlohmann::ordered_json ancestor(const std::pair<std::string, std::string> &a, Preset::Type type, const std::vector<const Source *> &sources)
    {
        for (const Source *s : sources)
            if (s->vendor == a.first && s->name == a.second) return s->values;
        for (const std::vector<Source> *all : {&machines, &processes, &filaments})
            for (const Source &s : *all)
                if (s.vendor == a.first && s.name == a.second) return s.values;
        const auto it = bases.find({a.first, type, a.second});
        if (it == bases.end()) throw std::runtime_error("unresolved base " + a.first + "/" + a.second);
        return it->second;
    }

    static nlohmann::ordered_json diff(const nlohmann::ordered_json &base, const nlohmann::ordered_json &values)
    {
        nlohmann::ordered_json out = nlohmann::ordered_json::object();
        for (const auto &[key, value] : values.items())
            if (!base.contains(key) || base[key] != value) out[key] = value;
        for (const auto &[key, value] : base.items())
            if (!values.contains(key)) throw std::runtime_error("a source lacks the base key " + key);
        return out;
    }

    std::vector<nlohmann::ordered_json> products(std::vector<Source> &all, Preset::Type type)
    {
        std::map<std::string, std::vector<const Source *>> groups;
        for (const Source &s : all) groups[group_of(s, type)].push_back(&s);
        for (auto &[id, sources] : groups)
            std::sort(sources.begin(), sources.end(), [](const Source *a, const Source *b) { return a->name < b->name; });
        auto owners = [](const std::vector<const Source *> &sources) {
            std::map<std::string, const Source *> owner;
            for (const Source *s : sources)
                for (const std::string &printer : s->fits) {
                    const Source *&cur = owner[printer];
                    const bool named = std::find(s->named.begin(), s->named.end(), printer) != s->named.end();
                    const bool cur_named = cur && std::find(cur->named.begin(), cur->named.end(), printer) != cur->named.end();
                    if (cur == nullptr || (named && !cur_named)) cur = s;
                }
            return owner;
        };
        for (bool split = true; split;) {
            split = false;
            for (auto &[id, sources] : groups) {
                const auto owner = owners(sources);
                for (const Source *s : sources) {
                    for (const std::string &printer : s->fits) {
                        const Source *o = owner.at(printer);
                        if (o == s || o->values == s->values) continue;
                        const Source *moved = s->name != id ? s : o;
                        sources.erase(std::find(sources.begin(), sources.end(), moved));
                        groups[moved->name] = {moved};
                        splits.push_back(moved->name + " (from " + id + ": differs from " + (moved == s ? o : s)->name + " on " + printer + ")");
                        split = true;
                        break;
                    }
                    if (split) break;
                }
                if (split) break;
            }
        }
        std::vector<nlohmann::ordered_json> out;
        for (auto &[id, sources] : groups) {
            nlohmann::ordered_json from;
            const nlohmann::ordered_json base = base_of(id, type, sources, from);
            const auto owner = owners(sources);
            for (const Source *s : sources) product_of[{type, s->name}] = id;
            nlohmann::ordered_json product = {{"id", id}};
            if (type == Preset::TYPE_FILAMENT) {
                DynamicPrintConfig b;
                apply_record_values(b, base);
                std::string display;
                std::string brand = b.has("filament_vendor") ? b.option<ConfigOptionStrings>("filament_vendor")->get_at(0) : "";
                if (brand.empty() || brand == "(Undefined)") {
                    const Source *first = sources.front();
                    brand = first->library ? id.substr(0, id.find(' ')) : vendor_names.at(first->vendor);
                    unbranded.push_back(id + " -> " + brand);
                }
                product["brand"] = brand;
                product["type"]  = b.has("filament_type") ? b.option<ConfigOptionStrings>("filament_type")->get_at(0) : "";
            }
            std::set<std::string> aliases;
            if (type == Preset::TYPE_FILAMENT)
                for (const auto &[from, into] : folds)
                    if (into == id) aliases.insert(from.second);
            if (!aliases.empty()) product["aliases"] = aliases;
            product["base"] = base;
            product["base_from"] = from;
            nlohmann::ordered_json tunings = nlohmann::ordered_json::array();
            for (const Source *s : sources) {
                nlohmann::ordered_json fits = nlohmann::ordered_json::array();
                for (const std::string &printer : s->fits) {
                    ++pairs;
                    if (owner.at(printer) == s) {
                        fits.push_back(printer);
                        if (type == Preset::TYPE_PRINT) print_fits[id].insert(printer);
                    }
                    else if (owner.at(printer)->values == s->values) { ++shadowed; shadows.push_back(s->name + " on " + printer + " (" + owner.at(printer)->name + ")"); }
                    else throw std::runtime_error(s->name + " on " + printer + " would take other values");
                }
                nlohmann::ordered_json values = diff(base, s->values);
                nlohmann::ordered_json resolved = base;
                if (type == Preset::TYPE_FILAMENT) {
                    DynamicPrintConfig b, t;
                    apply_record_values(b, base);
                    apply_record_values(t, values);
                    for (const auto &[key, value] : variant_projection(b, tuning_variants(b, t))) {
                        if (values.contains(key) && values[key] == value) values.erase(key);
                        if (!values.contains(key)) resolved[key] = value;
                    }
                }
                resolved.update(values);
                if (resolved != s->values) throw std::runtime_error(s->name + " does not resolve to its own values");
                tuning_keys[type] += values.size();
                tunings.push_back(nlohmann::ordered_json{{"fits", fits}, {"values", values}, {"source", s->json}});
            }
            product["tunings"] = tunings;
            out.push_back(std::move(product));
        }
        return out;
    }

    std::vector<std::string> no_default_print;
    std::vector<nlohmann::ordered_json> printers()
    {

        std::map<std::string, std::vector<const Source *>> groups;
        for (const Source &s : machines) {
            DynamicPrintConfig c;
            apply_record_values(c, s.values);
            groups[c.opt_string("printer_model")].push_back(&s);
        }
        std::vector<nlohmann::ordered_json> out;
        for (auto &[id, sources] : groups) {
            std::sort(sources.begin(), sources.end(), [](const Source *a, const Source *b) { return a->name < b->name; });
            nlohmann::ordered_json from;
            const nlohmann::ordered_json base = base_of(id, Preset::TYPE_PRINTER, sources, from);
            const std::string vendor = model_vendor.count(id) ? model_vendor[id] : sources.front()->vendor;
            nlohmann::ordered_json printer = {{"id", id}, {"vendor", vendor}, {"vendor_name", vendor_names[vendor]},
                {"model", models.count(id) ? models[id] : nlohmann::ordered_json::object()}, {"base", base}, {"base_from", from}};
            std::set<std::string> sizes;
            nlohmann::ordered_json variants = nlohmann::ordered_json::array();
            for (const Source *s : sources) {
                DynamicPrintConfig c;
                apply_record_values(c, s->values);
                const std::string nozzle = nozzle_text(c);
                const nlohmann::ordered_json values = diff(base, s->values);
                nlohmann::ordered_json resolved = base;
                resolved.update(values);
                if (resolved != s->values) throw std::runtime_error(s->name + " does not resolve to its own values");
                std::string default_print = c.opt_string("default_print_profile");
                default_print = default_print.substr(0, default_print.find(';'));
                nlohmann::ordered_json variant = {{"id", s->name}, {"nozzle", nozzle}, {"default", sizes.insert(nozzle).second}};
                if (const auto print = product_of.find({Preset::TYPE_PRINT, default_print}); print != product_of.end())
                    variant["defaultPrint"] = print->second;
                else if (const auto fits = print_fits.find(product_id(default_print)); fits != print_fits.end() && fits->second.count(s->name)) {
                    variant["defaultPrint"] = fits->first;
                    repaired_default_print.push_back(s->name + " (names " + default_print + ", takes " + fits->first + ")");
                } else
                    no_default_print.push_back(s->name + (default_print.empty() ? "" : " (names " + default_print + ")"));
                const auto *diameters = c.option<ConfigOptionFloats>("nozzle_diameter");
                variant["extruders"] = diameters->size();
                nlohmann::ordered_json nozzles = nlohmann::ordered_json::array();
                for (const double d : diameters->values) {
                    std::ostringstream text;
                    text << d;
                    nozzles.push_back({{"diameter", text.str()}});
                }
            }
            printer["variants"] = variants;
            out.push_back(std::move(printer));
        }
        return out;
    }
};

nlohmann::ordered_json fold_candidates(const std::vector<nlohmann::ordered_json> &filaments, const std::map<std::string, std::string> &vendor_names)
{
    auto lower = [](std::string s) { boost::algorithm::to_lower(s); return s; };
    auto words = [&](const std::string &s) { std::vector<std::string> w; boost::algorithm::split(w, lower(s), boost::is_any_of(" "), boost::token_compress_on); w.erase(std::remove(w.begin(), w.end(), ""), w.end()); return w; };
    auto first = [&](const std::string &s) { const auto w = words(s); return w.empty() ? std::string() : w.front(); };
    auto vendors = [](const nlohmann::ordered_json &p) { std::set<std::string> v; for (const auto &t : p["tunings"]) v.insert(t["source"].value("vendor", "")); return v; };
    auto own = [&](const std::string &vendor, const std::string &brand) {
        if (vendor == PresetBundle::ORCA_FILAMENT_LIBRARY) return true;
        const auto name = vendor_names.count(vendor) ? vendor_names.at(vendor) : vendor;
        return !brand.empty() && (boost::starts_with(lower(brand), first(name)) || boost::starts_with(lower(name), first(brand)));
    };
    auto density = [](const nlohmann::ordered_json &p) {
        const std::string d = p["base"].value("filament_density", "");
        return d.empty() ? -1. : std::atof(d.substr(0, d.find(',')).c_str());
    };
    nlohmann::ordered_json folds = nlohmann::ordered_json::array(), separate = nlohmann::ordered_json::array();
    for (const auto &p : filaments) {
        const auto vs = vendors(p);
        const std::string brand = p.value("brand", ""), type = p.value("type", ""), id = p["id"];
        if (vs.size() != 1 || brand.empty() || lower(brand) == "generic" || own(*vs.begin(), brand)) continue;
        const std::string vendor = *vs.begin();
        const auto mine = words(id);
        std::vector<const nlohmann::ordered_json *> targets;
        bool brand_has_type = false;
        for (const auto &t : filaments) {
            if (&t == &p || t.value("brand", "") != brand || t.value("type", "") != type) continue;
            const auto tv = vendors(t);
            if (std::none_of(tv.begin(), tv.end(), [&](const std::string &v) { return own(v, brand); })) continue;
            brand_has_type = true;
            auto theirs = words(t["id"]);
            bool holds = std::all_of(mine.begin(), mine.end(), [&](const std::string &w) { return std::find(theirs.begin(), theirs.end(), w) != theirs.end(); });
            bool extra_basic = std::all_of(theirs.begin(), theirs.end(), [&](const std::string &w) { return w == "basic" || std::find(mine.begin(), mine.end(), w) != mine.end(); });
            if (holds && extra_basic) targets.push_back(&t);
        }
        nlohmann::ordered_json entry = {{"from", id}, {"vendor", vendor}, {"brand", brand}, {"type", type}};
        if (targets.size() == 1) {
            const auto &t = *targets.front();
            const double a = density(p), b = density(t);
            entry["into"] = t["id"];
            entry["evidence"] = {{"brand", brand}, {"type", type}, {"words", "every word of " + id + " is in " + std::string(t["id"])},
                                 {"tunings", p["tunings"].size()}, {"density", {a, b}}, {"into_base", t["base_from"].value("name", "")}};
            if (a > 0 && b > 0 && std::abs(a - b) <= 0.03) folds.push_back(entry);
            else { entry["reason"] = "densities differ"; separate.push_back(entry); }
        } else {
            entry["reason"] = targets.empty() ? (brand_has_type ? "no product of the brand with the same name" : "the brand has no product of its own of this type")
                                              : "several products of the brand match";
            nlohmann::ordered_json names = nlohmann::ordered_json::array();
            for (const auto *t : targets) names.push_back((*t)["id"]);
            if (!targets.empty()) entry["matches"] = names;
            separate.push_back(entry);
        }
    }
    if (manifest.contains("machine_model_list")) for (const auto &entry : manifest.at("machine_model_list"))
        catalog["printer_models"].push_back(read_catalog_json(fs::path(args.profiles) / args.vendor / entry.at("sub_path").get<std::string>()));
    write_catalog(args.dump_presets, catalog);
}
}
