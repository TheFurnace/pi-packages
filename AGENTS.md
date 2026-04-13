Repository: pi-packages

This repo is a monorepo of pi packages (extensions). It intentionally groups multiple independent pi extensions under packages/ so you can develop them together and publish/install them independently.

Layout

packages/
  <package-name>/
    index.ts
    package.json

How to install

- Install the whole repository from git (clones the repo into pi's package dir):
  pi install git:github.com/TheFurnace/pi-packages

- Install a single package locally (clone the repo and point to the package folder):
  pi install /home/<user>/Repos/pi-packages/packages/sandbox

