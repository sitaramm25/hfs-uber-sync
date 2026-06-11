name: Uber Sync

on:
  push:
    branches:
      - main
    paths-ignore:
      - "**.yml"
  workflow_dispatch:

jobs:
  uber-sync:
    runs-on: [self-hosted, windows]

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Run Uber Sync
        run: npx tsx uber-sync.ts