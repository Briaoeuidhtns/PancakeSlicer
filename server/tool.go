package main

import (
	"errors"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

type ToolFeatures struct {
	ColourChange         map[string]bool `json:"colour_change"`
	PlateIndex           bool            `json:"plate_index"`
	PlatePlacement       bool            `json:"plate_placement"`
	DumpOptions          bool            `json:"dump_options"`
	DumpPresets          bool            `json:"dump_presets"`
	Progress             bool            `json:"progress"`
	MovesOut             bool            `json:"moves_out"`
	ObjectSettings       bool            `json:"object_settings"`
	Step                 bool            `json:"step"`
	Edit                 bool            `json:"edit"`
	ForcePlanar          bool            `json:"force_planar"`
	Cut                  bool            `json:"cut"`
	PatchPreview         bool            `json:"patch_preview"`
	PlanTops             bool            `json:"plan_tops"`
	SurfaceGrid          bool            `json:"surface_grid"`
	Calib                bool            `json:"calib"`
	Volumes              bool            `json:"volumes"`
	PresetCompat         bool            `json:"preset_compat"`
	OneShot              bool            `json:"oneshot"`
	CurvedTops           bool            `json:"curved_tops"`
	NonplanarWave        bool            `json:"nonplanar_wave"`
	MeshPlates           bool            `json:"mesh_plates"`
	PlateLocks           bool            `json:"plate_locks"`
	Paint                bool            `json:"paint"`
	LayerProfile         bool            `json:"layer_profile"`
	Arrange              bool            `json:"arrange"`
	ProjectVolumes       bool            `json:"project_volumes"`
	ProjectPaint         bool            `json:"project_paint"`
	OrientScores         bool            `json:"orient_scores"`
	Floating             bool            `json:"floating"`
	Ranges               bool            `json:"ranges"`
	MovesExtended        bool            `json:"moves_extended"`
	MixedTemperatures    bool            `json:"mixed_temperatures"`
	ArrangeMaterials     bool            `json:"arrange_materials"`
	WipeTower            bool            `json:"wipe_tower"`
	Explode              bool            `json:"explode"`
	CutConnectors        bool            `json:"cut_connectors"`
	MeshRepair           bool            `json:"mesh_repair"`
	MeshSimplify         bool            `json:"mesh_simplify"`
	MeshSimplifyError    bool            `json:"mesh_simplify_error"`
	NativeSupport        bool            `json:"native_support"`
	MeshBoolean          bool            `json:"mesh_boolean"`
	EmbossText           bool            `json:"emboss_text"`
	EmbossSVG            bool            `json:"emboss_svg"`
	EmbossSVGSurface     bool            `json:"emboss_svg_surface"`
	EmbossSurface        bool            `json:"emboss_surface"`
	ExportGeneric3MF     bool            `json:"export_generic_3mf"`
	ExportDRC            bool            `json:"export_drc"`
	EmbossSurfaceOutside bool            `json:"emboss_surface_outside"`
	PresetCache          bool            `json:"preset_cache"`
	StageCache           bool            `json:"stage_cache"`
	BrimEars             bool            `json:"brim_ears"`
	SeamParts            bool            `json:"seam_parts"`
}

type toolOption struct {
	Key  string `json:"key"`
	Type string `json:"type"`
	Mode int    `json:"mode"`
}

func toolDump(c Config, args ...string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "orca-catalog-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "catalog.json")
	args = append(args, path, "--profiles", filepath.Join(c.Resources, "profiles"), "--datadir", filepath.Join(dir, "data"))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Tool, args...)
	cmd.Env = engineEnv(dir)
	configureKill(cmd)
	cmd.WaitDelay = 5 * time.Second
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("tool catalog: %w: %.1000s", err, output)
	}
	return os.ReadFile(path)
}

func loadOptions(c Config) (*cachedResponse, error) {
	b, err := toolDump(c, "--dump-options")
	if err != nil {
		return nil, fmt.Errorf("the engine cannot dump its options: %w", err)
	}
	var dump struct {
		Schema  string            `json:"schema"`
		Options []json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(b, &dump); err != nil || dump.Schema != "orca.options.v1" || len(dump.Options) == 0 {
		return nil, errors.New("the engine's options dump is not orca.options.v1")
	}
	options := map[string]map[string]any{}
	kinds := map[string]string{}
	for _, raw := range dump.Options {
		var option toolOption
		var value map[string]any
		if json.Unmarshal(raw, &option) != nil || json.Unmarshal(raw, &value) != nil || option.Key == "" || option.Type == "" {
			return nil, errors.New("the engine's options dump has an invalid entry")
		}
		if hiddenSetting.MatchString(option.Key) {
			continue
		}
		kind := "comma"
		switch option.Type {
		case "string", "strings":
			kind = option.Type
		case "points_groups", "ints_groups":
			kind = "groups"
		}
		kinds[option.Key] = kind
		types := map[string]string{"float_or_percent": "FloatOrPercent", "floats_or_percents": "FloatsOrPercents", "points_groups": "PointsGroups", "ints_groups": "IntsGroups"}
		typ := types[option.Type]
		if typ == "" {
			typ = strings.ToUpper(option.Type[:1]) + option.Type[1:]
		}
		value["type"] = typ
		if option.Type == "strings" {
			if serialized, ok := value["default"].(string); ok {
				value["default"] = nativeStrings(serialized)
			}
		}
		mode := "Develop"
		switch option.Mode {
		case 0:
			mode = "Simple"
		case 1:
			mode = "Advanced"
		case 2:
			mode = "Expert"
		}
		value["mode"] = mode
		options[option.Key] = value
	}
	response, err := cacheJSON(options)
	if err != nil {
		log.Printf("using legacy tool contract: %v", err)
		return fallback
	}
	configKinds = kinds
	modes, _ := options["nonplanar_mode"]["enum_values"].([]any)
	oneshot, curvedTops, wave := false, false, false
	for _, mode := range modes {
		oneshot = oneshot || mode == "oneshot"
		curvedTops = curvedTops || mode == "nonplanar_top"
	}
	waveModes, _ := options["nonplanar_wave"]["enum_values"].([]any)
	for _, mode := range waveModes {
		wave = wave || mode == "whole"
	}
	log.Printf("using native v1 tool contract (%d options)", len(options))
	f.DumpOptions, f.DumpPresets, f.Progress, f.MovesOut, f.ObjectSettings = true, true, true, true, true
	f.OneShot, f.CurvedTops, f.NonplanarWave, f.NativeSupport = oneshot, curvedTops, wave, nativeSupport
	return response
}

func nativeStrings(value string) []string {
	if value == "" {
		return []string{}
	}
	var result []string
	var part strings.Builder
	quoted, escaped := false, false
	for _, ch := range value {
		if escaped {
			switch ch {
			case 'n':
				ch = '\n'
			case 'r':
				ch = '\r'
			}
			part.WriteRune(ch)
			escaped = false
		} else {
			switch ch {
			case '\\':
				escaped = true
			case '"':
				quoted = !quoted
			case ';':
				if quoted {
					part.WriteRune(ch)
				} else {
					result = append(result, part.String())
					part.Reset()
				}
			default:
				part.WriteRune(ch)
			}
		}
	}
	if escaped {
		part.WriteRune('\\')
	}
	return append(result, part.String())
}

func (p *PresetIndex) dumpVendor(vendor string) (*VendorPresets, error) {
	b, err := toolDump(*p.tool, "--dump-presets", vendor)
	if err != nil {
		return nil, err
	}
	log.Printf("engine option dictionary: %d options", len(options))
	return response, nil
}
