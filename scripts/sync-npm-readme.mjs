/**
 * Copy the repository README into the npm plugin package.
 *
 * npm renders the package README on its own domain, so repository-relative
 * images and links must become absolute URLs before publishing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = 'https://github.com/ds-hu/dsh-acp-paseo';
const raw = 'https://raw.githubusercontent.com/ds-hu/dsh-acp-paseo/main';

let readme = await readFile(join(root, 'README.md'), 'utf8');
readme = readme.replaceAll('docs/images/', `${raw}/docs/images/`);
readme = readme.replaceAll('](docs/TECHNICAL.md)', `](${repo}/blob/main/docs/TECHNICAL.md)`);
readme = readme.replaceAll('](docs/PROVIDER.md)', `](${repo}/blob/main/docs/PROVIDER.md)`);
readme = readme.replaceAll('](docs/CONTEXT.md)', `](${repo}/blob/main/docs/CONTEXT.md)`);
readme = readme.replaceAll('](LICENSE)', `](${repo}/blob/main/LICENSE)`);
readme = readme.replaceAll('](THIRD_PARTY_NOTICES.md)', `](${repo}/blob/main/THIRD_PARTY_NOTICES.md)`);

await writeFile(join(root, 'packages', 'paseo-provider', 'README.md'), readme);
console.log('synced packages/paseo-provider/README.md from README.md');
