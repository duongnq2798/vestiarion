import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "../src/lib/api/openapi";
import { renderPostman, type OpenApiDoc } from "./lib/postman";

/**
 * Writes the Postman collections and environment into public/postman/, from the API's OpenAPI document. The site
 * serves them at https://www.vestiarion.xyz/postman/<file>, the URL Postman imports from. Run after changing an
 * operation, a parameter, an example or an error:
 *
 *   npm run postman:build
 *
 * tests/postman.test.ts fails while a committed file is not what this renders.
 */
const destination = path.resolve(import.meta.dirname, "../public/postman");
mkdirSync(destination, { recursive: true });
const files = renderPostman(buildOpenApiDocument("https://www.vestiarion.xyz") as unknown as OpenApiDoc);
for (const [name, text] of Object.entries(files)) {
  writeFileSync(path.join(destination, name), text);
  console.log(`wrote public/postman/${name}`);
}
