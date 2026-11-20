{ lib
, stdenv
, makeWrapper
, nodejs_26
, python312
, buildNpmPackage
, electron
, ffmpeg
, coreutils
, engine
, web
, server
, revision
, source ? ../desktop
}:

let
  shell = buildNpmPackage {
    pname = "pancakeslicer-desktop-shell";
    version = "0.4.2";
    src = source;
    nodejs = nodejs_26;
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    npmDepsHash = "sha256-NK9qrqo+hcOQSlmvdx+njh079jY9pfWjiEjqyPVt0G4=";
    npmBuildScript = "compile";
    installPhase = ''
      mkdir -p $out/libexec/pancakeslicer-desktop
      cp -R out package.json $out/libexec/pancakeslicer-desktop/
    '';
  };
in
stdenv.mkDerivation (finalAttrs:
let
  runtimeEngine = engine.overrideAttrs { doCheck = finalAttrs.doCheck; };
  runtimeServer = server.overrideAttrs { doCheck = finalAttrs.doCheck; };
in {
  pname = "pancakeslicer-desktop";
  version = "0.4.2";
  dontUnpack = true;
  doCheck = true;

  nativeBuildInputs = [ makeWrapper python312 ];

  installPhase = ''
    root=$out/libexec/pancakeslicer
    payload=$root/build
    bundled_engine=$payload/engine-linux-x64
    mkdir -p "$out/bin" "$root/out" "$bundled_engine" "$payload/web"
    cp ${shell}/libexec/pancakeslicer-desktop/out/*.js "$root/out/"
    cp ${shell}/libexec/pancakeslicer-desktop/package.json "$root/"
    cp ${runtimeEngine}/bin/nonplanar_slice_tool "$bundled_engine/"
    cp -R ${runtimeEngine}/resources/. "$bundled_engine/resources/"
    cp ${runtimeEngine}/surface-manifest.json "$bundled_engine/"
    cp -R ${web}/share/pancakeslicer/web/. "$payload/web/"
    cp ${runtimeServer}/bin/pancakeslicer-server "$bundled_engine/orca-webapp-server"
    cp ${runtimeServer}/share/pancakeslicer/server/schemas.json "$bundled_engine/"
    makeWrapper ${electron}/bin/electron $out/bin/pancakeslicer \
      --add-flags "$root/out/main.js" \
      --prefix PATH : ${lib.makeBinPath [ ffmpeg coreutils ]} \
      --run "cd $root"
  '';

  # The engine hash must describe the copied executable after the last fixup.
  dontStrip = true;
  dontPatchELF = true;
  postFixup = ''
    BUNDLE_ENGINE="$out/libexec/pancakeslicer/build/engine-linux-x64" \
    BUNDLE_WEB="$out/libexec/pancakeslicer/build/web" \
    BUNDLE_REVISION="${revision}" python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

engine = Path(os.environ["BUNDLE_ENGINE"])
web = Path(os.environ["BUNDLE_WEB"])
def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

manifest = json.loads((engine / "surface-manifest.json").read_text())
native_hash = digest(engine / "nonplanar_slice_tool")
if manifest["binary_sha256"] != native_hash:
    raise RuntimeError("Native executable differs from the engine identity manifest")
resources_hash = hashlib.sha256()
def visit(directory):
    for path in sorted(directory.iterdir(), key=lambda p: p.name):
        if path.is_symlink():
            raise RuntimeError(f"Resource symlink: {path}")
        if path.is_dir():
            visit(path)
        elif path.is_file():
            relative = path.relative_to(engine / "resources").as_posix()
            resources_hash.update(f"{relative}\0{digest(path)}\n".encode())
        else:
            raise RuntimeError(f"Nonregular resource: {path}")
visit(engine / "resources")
if manifest["resources_sha256"] != resources_hash.hexdigest():
    raise RuntimeError("Bundled resources differ from the engine identity manifest")
if manifest["source_sha"] != os.environ["BUNDLE_REVISION"]:
    raise RuntimeError("Engine source identity differs from the desktop revision")

components = {
    "client_source": os.environ["BUNDLE_REVISION"],
    "server_source": os.environ["BUNDLE_REVISION"],
    "native_source": manifest["source_sha"],
    "native_binary_sha256": native_hash,
    "native_resources_sha256": resources_hash.hexdigest(),
    "server_binary_sha256": digest(engine / "orca-webapp-server"),
    "native_manifest_sha256": digest(engine / "surface-manifest.json"),
}
payload = json.dumps(components, indent=2) + "\n"
(engine / "COMPONENTS.json").write_text(payload)
(web / "COMPONENTS.json").write_text(payload)
(web / "REVISION.txt").write_text(os.environ["BUNDLE_REVISION"] + "\n")
PY
  '';

  meta = {
    description = "PancakeSlicer Electron desktop application";
    homepage = "https://github.com/ZimengXiong/PancakeSlicer";
    license = lib.licenses.agpl3Only;
    platforms = [ "x86_64-linux" ];
    mainProgram = "pancakeslicer";
  };
})
