import type { NextConfig } from "next";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    root: workspaceRoot
  }
};

export default nextConfig;
