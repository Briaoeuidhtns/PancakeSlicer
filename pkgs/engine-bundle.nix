{
  lib,
  stdenvNoCC,
  fetchurl,
  python3,
  engine,
  revision,
}:

let
  python = python3.withPackages (ps: [ ps.numpy ps.scipy ps.markdown ]);
  suite = ../engine/scripts/qualification;
  # Independent regression baseline for the current fixture set. The release
  # proof itself is not reusable: it describes a different engine build.
  upstreamEvidence = fetchurl {
    url = "https://github.com/ZimengXiong/PancakeSlicer/releases/download/v0.5.4/PancakeSlicer-linux-x64-qualification.zip";
    hash = "sha256-U5/vsIG1Reshcu3nssho+Vud3m8p3+qZLdAkzt0d88U=";
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pancakeslicer-engine";
  inherit (engine) version;
  dontUnpack = true;
  dontConfigure = true;

  doCheck = true;
  nativeCheckInputs = [ python ];
  buildPhase = ''
    runHook preBuild
    mkdir -p stage
    cp ${engine.manifest} stage/surface-manifest.json
    runHook postBuild
  '';
  checkPhase = lib.optionalString finalAttrs.doCheck ''
    runHook preCheck
    export HOME="$PWD/home"
    mkdir -p "$HOME"

    python3 -B ${suite}/qualify.py \
      --tool ${engine}/bin/nonplanar_slice_tool \
      --resources ${engine}/resources \
      --engine-source ${revision} --output checks
    PYTHONPATH=${suite} python3 -B - ${upstreamEvidence} <<'PY'
import json
from pathlib import Path
import sys
import zipfile

from qualify import compare_gcode

with zipfile.ZipFile(sys.argv[1]) as release:
    proof = json.loads(release.read("qualification.json"))
    if not proof["ready"] or proof["platform"] != {"os": "linux", "arch": "x86_64"}:
        sys.exit("Expected qualified Linux x86-64 release evidence")
    match = compare_gcode(release.read("benchy_flat/out.gcode"),
                          Path("checks/benchy_flat/out.gcode").read_bytes())
    print("Flat Benchy vs upstream v0.5.4:", json.dumps(match), flush=True)
    if match["identity"] == "diff":
        sys.exit("Flat Benchy G-code differs from the pinned upstream reference")
PY
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp stage/surface-manifest.json "$out/"
    ln -s ${engine}/bin "$out/bin"
    cp -R ${engine}/resources "$out/resources"
    runHook postInstall
  '';
  passthru.manifest = engine.manifest;
  meta = engine.meta;
})
