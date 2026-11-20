self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.pancakeslicer;
  system = pkgs.stdenv.hostPlatform.system;
  host = if lib.hasInfix ":" cfg.listenAddress then "[${cfg.listenAddress}]" else cfg.listenAddress;
in
{
  options.services.pancakeslicer = {
    enable = lib.mkEnableOption "the PancakeSlicer web service";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.server or (throw "PancakeSlicer's native server is not packaged for ${system}");
      defaultText = lib.literalExpression "pancakeslicer.packages.\${pkgs.stdenv.hostPlatform.system}.server";
      description = "PancakeSlicer server package, including its engine and web assets.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address to bind. Write an IPv6 literal without brackets.";
    };

    port = lib.mkOption {
      type = lib.types.ints.between 1 65535;
      default = 6868;
      description = "HTTP port for the browser UI and API. This module does not open the firewall.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/pancakeslicer-env";
      description = "Optional systemd environment file for server settings and secrets (such as ORCA_WEB_BEARER_TOKEN).";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.pancakeslicer = {
      description = "PancakeSlicer web service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        ORCA_WEB_LISTEN = "${host}:${toString cfg.port}";
        ORCA_WEB_DATA_DIR = "library";
        ORCA_WEB_JOB_ROOT = "jobs";
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        DynamicUser = true;
        StateDirectory = "pancakeslicer";
        StateDirectoryMode = "0700";
        WorkingDirectory = "%S/pancakeslicer";
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        NoNewPrivileges = true;
        PrivateTmp = true;
      };
    };
  };
}
