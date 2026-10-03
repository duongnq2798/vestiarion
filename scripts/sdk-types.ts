import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "../src/lib/api/openapi";
import { renderSdkTypes, type OpenApiDoc } from "./lib/sdk-types";

/**
 * Writes sdk/src/types.ts from the API's OpenAPI document. Run after changing an operation, a schema or a parameter:
 *
 *   npm run sdk:types
 *
 * tests/sdk-types.test.ts fails while the committed file is not what this renders.
 */
const out = path.resolve(import.meta.dirname, "../sdk/src/types.ts");
writeFileSync(out, renderSdkTypes(buildOpenApiDocument("https://www.vestiarion.xyz") as unknown as OpenApiDoc));
console.log(`wrote ${out}`);
