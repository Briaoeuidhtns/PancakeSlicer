{ lib, buildGoModule, go_1_27, revision, source ? ../server }:

(buildGoModule.override { go = go_1_27; }) {
  pname = "pancakeslicer-server";
  version = "0.5.0";
  src = source;
  vendorHash = null;
  subPackages = [ "." ];
  ldflags = [ "-s" "-w" "-X main.buildRevision=${revision}" ];

  postInstall = ''
    mv $out/bin/server $out/bin/pancakeslicer-server
    install -Dm644 schemas.json $out/share/pancakeslicer/server/schemas.json
  '';

  meta = {
    description = "PancakeSlicer's Go web service";
    homepage = "https://github.com/ZimengXiong/PancakeSlicer";
    license = lib.licenses.agpl3Only;
    platforms = [ "x86_64-linux" ];
  };
}
