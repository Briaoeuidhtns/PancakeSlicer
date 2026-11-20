{ lib
, stdenv
, cmake
, ninja
, pkg-config
, gettext
, python312
, uv
, boost187
, eigen_5
, tbb
, openssl
, curl
, freetype
, fontconfig
, zlib
, expat
, libpng
, libjpeg
, libGL
, libGLU
, dbus
, glfw
, cereal
, nlopt
, openvdb
, c-blosc
, imath
, libnoise
, cgal
, opencv
, assimp
, opencascade-occt
, draco
, gmp
, mpfr
, runCommand
, revision
}:

let
  # The engine uses Boost.Process v1, removed in Boost 1.88.
  boost = boost187;
  engineOpenvdb = openvdb.override { inherit boost; };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "pancakeslicer-headless-engine";
  version = "0.5.0";
  src = ../engine;

  nativeBuildInputs = [ cmake ninja pkg-config gettext python312 uv ];
  buildInputs = [
    boost eigen_5 tbb openssl curl freetype fontconfig zlib expat libpng libjpeg
    libGL libGLU dbus glfw cereal nlopt engineOpenvdb cgal opencv assimp
    opencascade-occt draco python312 gmp mpfr
    c-blosc imath libnoise
  ];

  postPatch = ''
    substituteInPlace CMakeLists.txt \
      --replace-fail 'set(_bundled_python_version "3.12.13")' 'set(_bundled_python_version "${python312.version}")' \
      --replace-fail 'set(_bundled_python_root "''${CMAKE_PREFIX_PATH}/libpython")' 'set(_bundled_python_root "${python312}")'
    substituteInPlace src/CMakeLists.txt \
      --replace-fail 'if (NOT APPLE)' 'if (NOT APPLE AND SLIC3R_GUI)'
    substituteInPlace src/libslic3r/CMakeLists.txt \
      --replace-fail 'set(OpenCASCADE_DIR "''${CMAKE_PREFIX_PATH}/lib/cmake/occt")' "" \
      --replace-fail 'find_package(OpenCV REQUIRED core)' 'find_package(OpenCV REQUIRED core imgproc imgcodecs)' \
      --replace-fail 'opencv_world' 'opencv_core opencv_imgproc opencv_imgcodecs'
    substituteInPlace cmake/modules/Findlibnoise.cmake \
      --replace-fail 'libnoise/noise.h' 'noise/noise.h' \
      --replace-fail 'NAMES libnoise libnoise_static' 'NAMES noise-static libnoise libnoise_static'
    substituteInPlace src/libslic3r/Feature/FuzzySkin/FuzzySkin.cpp \
      --replace-fail 'libnoise/' 'noise/'
    # Use the find module that matches the packaged OpenVDB ABI.
    rm cmake/modules/FindOpenVDB.cmake
  '';

  configurePhase = ''
    cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DSLIC3R_GUI=OFF \
      -DSLIC3R_CAD=OFF \
      -DSLIC3R_STATIC=OFF \
      -DORCA_BUILD_PYTHON_STUBGEN_MODULE=OFF \
      -DCMAKE_MODULE_PATH=${lib.getDev engineOpenvdb}/lib/cmake/OpenVDB \
      -DORCA_BUNDLED_UV_EXECUTABLE=${lib.getExe uv} \
      -DBUILD_TESTS=ON \
      -DCMAKE_INSTALL_PREFIX=$out
  '';

  buildPhase = ''
    cmake --build build --target nonplanar_slice_tool --parallel $NIX_BUILD_CORES
  '';

  installPhase = ''
    install -Dm755 build/tests/fff_print/nonplanar_slice_tool $out/bin/nonplanar_slice_tool
    mkdir -p $out/resources
    for name in profiles nonplanar info printers filament_mixing fonts handy_models calib cert flush; do
      cp -R "resources/$name" "$out/resources/$name"
    done
    cp resources/catalog_folds.json "$out/resources/"
    chmod -R u+rwX,go+rX $out/resources
    $out/bin/nonplanar_slice_tool --flatten-catalog "$out/resources/catalog" \
      --profiles "$out/resources/profiles"
  '';

  passthru.manifest = runCommand "pancakeslicer-surface-manifest.json" { } ''
    # Hash only the final, stripped and RPATH-fixed executable and staged resources.
    ENGINE_ROOT=${finalAttrs.finalPackage} ENGINE_REVISION=${lib.escapeShellArg revision} ${lib.getExe python312} - <<'PY'
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ["ENGINE_ROOT"])
resources = root / "resources"
def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

identity = hashlib.sha256()
count = 0

def visit(directory):
    global count
    for path in sorted(directory.iterdir(), key=lambda p: p.name):
        if path.is_symlink():
            raise RuntimeError(f"Resource symlink: {path}")
        if path.is_dir():
            visit(path)
        elif path.is_file():
            identity.update(f"{path.relative_to(resources).as_posix()}\0{digest(path)}\n".encode())
            count += 1
        else:
            raise RuntimeError(f"Nonregular resource: {path}")
visit(resources)

manifest = {
    "schema": 3,
    "source_sha": os.environ["ENGINE_REVISION"],
    "publication_main_sha": os.environ["ENGINE_REVISION"],
    "platform": {"os": "linux", "arch": "x86_64"},
    "backend": "native",
    "available": True,
    "preview_ready": False,
    "print_qualified": False,
    "resource_file_count": count,
    "binary_sha256": digest(root / "bin/nonplanar_slice_tool"),
    "resources_sha256": identity.hexdigest(),
}
Path(os.environ["out"]).write_text(json.dumps(manifest, indent=2) + "\n")
PY
  '';

  enableParallelBuilding = true;
  strictDeps = true;

  meta = {
    description = "PancakeSlicer's headless non-planar slicing engine";
    homepage = "https://github.com/ZimengXiong/PancakeSlicer";
    license = lib.licenses.agpl3Only;
    platforms = [ "x86_64-linux" ];
  };
})
