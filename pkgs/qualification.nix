{
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
stdenvNoCC.mkDerivation {
  pname = "pancakeslicer-engine-qualification";
  inherit (engine) version;
  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;
  nativeBuildInputs = [ python ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export HOME="$PWD/home"
    mkdir -p "$HOME" stage/engine

    qualify() {
      python3 -B ${suite}/qualify.py \
        --tool ${engine}/bin/nonplanar_slice_tool \
        --resources ${engine}/resources \
        --engine-source ${revision} "$@"
    }

    # Follow the upstream two-pass workflow for a new engine source. Compare
    # the audited local baseline to the independently published flat fixture
    # as well, so qualifying a local rebuild cannot accept an arbitrary change.
    qualify --output stage/reference
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
                          Path("stage/reference/benchy_flat/out.gcode").read_bytes())
    print("Flat Benchy vs upstream v0.5.4:", json.dumps(match), flush=True)
    if match["identity"] == "diff":
        sys.exit("Flat Benchy G-code differs from the pinned upstream reference")
PY
    qualify --publication-source ${revision} --reference stage/reference --output stage/candidate
    python3 -B ${suite}/finalize.py --engine stage/engine \
      --qualification stage/candidate --evidence-archive stage/engine/evidence.zip

    # The independent identity stamp describes the final engine, whether or
    # not it passes qualification. Refuse to ship a record for other bytes.
    python3 -B - ${engine.manifest} <<'PY'
import json
from pathlib import Path
import sys

identity = json.loads(Path(sys.argv[1]).read_text())
qualified = json.loads(Path("stage/engine/surface-manifest.json").read_text())
for field in ("source_sha", "publication_main_sha", "platform", "binary_sha256",
              "resources_sha256", "resource_file_count"):
    if identity[field] != qualified[field]:
        sys.exit(f"Qualification does not match the independent engine stamp: {field}")
PY
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp stage/engine/{surface-manifest.json,artifact-qualification.ready,evidence.zip} "$out/"
    runHook postInstall
  '';
}
