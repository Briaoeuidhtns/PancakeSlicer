package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestEngineCapabilitiesWithoutQualification(t *testing.T) {
	root := t.TempDir()
	tool := filepath.Join(root, "engine")
	resources := filepath.Join(root, "resources")
	manifestPath := filepath.Join(root, "surface-manifest.json")
	if err := os.WriteFile(tool, []byte("engine build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(resources, 0o755); err != nil {
		t.Fatal(err)
	}
	resource := filepath.Join(resources, "profile.json")
	if err := os.WriteFile(resource, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	binary, err := bundleFileHash(tool)
	if err != nil {
		t.Fatal(err)
	}
	resourceHash, err := bundleResourceHash(resources)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(map[string]any{
		"available": true, "preview_ready": true, "print_qualified": false,
		"features": map[string]bool{"curved_tops": true, "nonplanar_wave": true},
		"binary_sha256": binary, "resources_sha256": resourceHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := Config{Tool: tool, Resources: resources, SurfaceManifest: manifestPath}
	if err := checkEngineBuild(&cfg); err != nil {
		t.Fatal(err)
	}
	health := newEngineHealth(cfg)
	if health.manifest["print_ready"] != true || health.manifest["print_qualified"] != false {
		t.Fatalf("capability readiness must not claim qualification: %v", health.manifest)
	}
	features := health.manifest["features"].(map[string]bool)
	if !features["curved_tops"] || !features["nonplanar_wave"] {
		t.Fatalf("missing qualification record disabled engine capabilities: %v", features)
	}
	if modes := health.manifest["wave_modes"].([]string); len(modes) != 1 || modes[0] != "whole" {
		t.Fatalf("wave capability did not advertise whole mode: %v", modes)
	}
	if health.qualifiedOutput(binary) {
		t.Fatal("unchecked build claimed an audited output")
	}
	if err := os.WriteFile(resource, []byte("changed profile"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := checkEngineBuild(&cfg); err == nil {
		t.Fatal("mismatched resources were accepted")
	}
}
