{
  description = "PancakeSlicer native Linux packaging and development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      appImageVersion = "0.4.8";
      releases = {
        x86_64-linux = { arch = "x86_64"; hash = "sha256:953551c217362e2ad20495839f59f1347cd82f809d6890493fe8b102c72ec918"; };
        aarch64-linux = { arch = "arm64"; hash = "sha256:e8804a0e2ef00ce68d1ab29ff3bae9423a100a89f6b92df52086e6bfd97d6370"; };
      };
      systems = builtins.attrNames releases;
      # The qualifier requires a 40-hex source identity, including for local builds.
      revision = self.rev or (builtins.hashString "sha1" (toString self.outPath));
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      }));
      nativeSystem = "x86_64-linux";
      appImage = pkgs: system:
        let
          pname = "pancakeslicer";
          version = appImageVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/ZimengXiong/PancakeSlicer/releases/download/v${version}/PancakeSlicer-${version}-linux-${releases.${system}.arch}.AppImage";
            inherit (releases.${system}) hash;
          };
          contents = pkgs.appimageTools.extract { inherit pname version src; };
        in pkgs.appimageTools.wrapType2 {
          inherit pname version src;
          extraInstallCommands = ''
            install -Dm444 ${contents}/pancakeslicer.desktop -t $out/share/applications
            substituteInPlace $out/share/applications/pancakeslicer.desktop --replace-fail 'Exec=AppRun' 'Exec=pancakeslicer'
            cp -r ${contents}/usr/share/icons $out/share
          '';
          meta = {
            description = "Non-planar 3D printing slicer";
            homepage = "https://github.com/ZimengXiong/PancakeSlicer";
            license = nixpkgs.lib.licenses.agpl3Only;
            sourceProvenance = [ nixpkgs.lib.sourceTypes.binaryNativeCode ];
            mainProgram = pname;
            platforms = systems;
          };
        };
    in {
      packages = forEachSystem (pkgs:
        let system = pkgs.stdenv.hostPlatform.system;
        in { default = appImage pkgs system; } // nixpkgs.lib.optionalAttrs (system == nativeSystem) (
          let
            engine-unwrapped = pkgs.callPackage ./pkgs/engine.nix { inherit revision; };
            engine = pkgs.callPackage ./pkgs/engine-bundle.nix {
              engine = engine-unwrapped;
              inherit revision;
            };
            web = pkgs.callPackage ./pkgs/web.nix { };
            server = pkgs.callPackage ./pkgs/server.nix { inherit revision; };
          in {
            inherit engine engine-unwrapped web;
            server-unwrapped = server;
            server = pkgs.callPackage ./pkgs/server-bundle.nix {
              inherit engine web server revision;
              source = self;
            };
            desktop = pkgs.callPackage ./pkgs/desktop.nix {
              inherit engine web server revision;
            };
          }
        ));

      apps = forEachSystem (pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
          packages = self.packages.${system};
          app = package: { type = "app"; program = nixpkgs.lib.getExe package; };
        in {
          default = app packages.default;
        } // nixpkgs.lib.optionalAttrs (system == nativeSystem) {
          server = app packages.server;
          desktop = app packages.desktop;
        });

      devShells = forEachSystem (pkgs: {
        default = pkgs.callPackage ./pkgs/shell.nix { };
      });

      checks.${nativeSystem} = {
        inherit (self.packages.${nativeSystem}) engine server;
      };

      nixosModules.pancakeslicer = import ./nixos/pancakeslicer.nix self;
      nixosModules.default = self.nixosModules.pancakeslicer;
    };
}
