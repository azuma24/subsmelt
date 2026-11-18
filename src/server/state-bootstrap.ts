import { acquireStateOwnership, stateDirectories } from "./state-ownership.js";

// This module must be the first import of the server entry point. Dependencies
// that load configuration or recover persisted work run only after it returns.
const ownership = acquireStateOwnership(stateDirectories());
process.env.DATA_DIR = ownership.directories.data;
process.env.CONFIG_DIR = ownership.directories.config;
process.env.CONVERT_BATCH_DIR = ownership.directories.batches;
process.once("exit", () => ownership.release());
