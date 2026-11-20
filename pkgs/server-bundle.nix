{
  lib,
  stdenvNoCC,
  makeWrapper,
  ffmpeg-headless,
  coreutils,
  engine,
  qualification,
  web,
  server,
  revision,
  source,
}:

stdenvNoCC.mkDerivation {
  pname = "pancakeslicer-server";
  inherit (server) version;
  dontUnpack = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    archive=$out/share/pancakeslicer/source.tar.gz
    mkdir -p "$(dirname "$archive")"
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C ${source} -czf "$archive" .
    sourceHash=$(sha256sum "$archive" | cut -d ' ' -f 1)
    makeWrapper ${server}/bin/pancakeslicer-server "$out/bin/pancakeslicer-server" \
      --prefix PATH : ${lib.makeBinPath [ ffmpeg-headless coreutils ]} \
      --set-default ORCA_WEB_TOOL ${engine}/bin/nonplanar_slice_tool \
      --set-default ORCA_WEB_RESOURCES ${engine}/resources \
      --set-default ORCA_WEB_SURFACE_MANIFEST ${qualification}/surface-manifest.json \
      --set-default ORCA_WEB_ARTIFACT_QUALIFICATION ${qualification}/artifact-qualification.ready \
      --set-default ORCA_WEB_STATIC ${web}/share/pancakeslicer/web \
      --set-default ORCA_WEB_LISTEN 127.0.0.1:6868 \
      --set-default ORCA_WEB_PRINTER_NETWORK off \
      --set-default ORCA_WEB_SOURCE_ARCHIVE "$archive" \
      --set-default ORCA_BUILD_SOURCE_SHA256 "$sourceHash" \
      --set-default ORCA_BUILD_REVISION ${lib.escapeShellArg revision}

    runHook postInstall
  '';

  meta = server.meta // { mainProgram = "pancakeslicer-server"; };
}
