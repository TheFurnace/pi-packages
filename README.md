pi-packages
===========

This repository contains multiple pi extensions under packages/. Use pi's package manager to add these to your pi installation.

Install examples

- Install from this repo (git):
  pi install git:github.com/TheFurnace/pi-packages

- Install a single package from a local clone (preferred for development):
  pi install /home/<you>/Repos/pi-packages/packages/sandbox
  pi install ./packages/notify
  pi install ./packages/turndown-web

Filtering (enable only specific resources from a package)

When you install a git repo, pi clones the whole repo. Control which resources pi loads by adding a package object to your settings (global: ~/.pi/agent/settings.json or project: .pi/settings.json). Example that installs this repo but only enables the sandbox extension:

{
  "packages": [
    {
      "source": "git:github.com/<youruser>/pi-packages",
      "extensions": [
        "packages/sandbox/*"
      ],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}

Notes on patterns

- Patterns are relative to the package root (the repo root for git installs).
- Use globs (e.g., "packages/sandbox/extensions/*.ts") and manifest-style operators:
  - "!pattern" to exclude matches
  - "+path" to force-include an exact path
  - "-path" to force-exclude an exact path
- An empty array (e.g., "skills": []) explicitly disables that resource type for the package.

Local-development workflow

- Clone this repo and install a single package directly by path while iterating:
  git clone git@github.com:TheFurnace/pi-packages.git
  pi install ./pi-packages/packages/sandbox

- Alternatively, install the repo via git then use the settings.json filter to enable only the package(s) you need.

Questions or want me to add workspace/package.json files for publishing? I can scaffold workspaces and package.json entries for each package on request.
