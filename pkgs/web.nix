{ lib, buildNpmPackage, fetchNpmDeps, nodejs_26 }:

let
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../LICENSE
      ../web
      ../engine/resources
      (lib.fileset.fileFilter (file: file.hasExt "json") ../server)
    ];
  };
in
buildNpmPackage {
  pname = "pancakeslicer-web";
  version = "0.5.0";
  src = source;

  nodejs = nodejs_26;
  npmRoot = "web";
  npmDeps = fetchNpmDeps {
    src = ../web;
    hash = "sha256-M1/zkZ5rBX5kmgWloHTsWtJlSKC3AvzU08rIGJJUEOs=";
  };

  dontNpmBuild = true;
  buildPhase = ''
    runHook preBuild
    npm --prefix web run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pancakeslicer/web
    cp -R web/dist/. $out/share/pancakeslicer/web/
    install -Dm644 LICENSE $out/share/pancakeslicer/web/licence.txt
    runHook postInstall
  '';

  meta = {
    description = "PancakeSlicer's web interface";
    homepage = "https://github.com/ZimengXiong/PancakeSlicer";
    license = lib.licenses.agpl3Only;
    platforms = [ "x86_64-linux" ];
  };
}
