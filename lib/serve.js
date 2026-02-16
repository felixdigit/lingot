import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR } from './config.js';

function loadPackages() {
  if (!existsSync(PACKAGES_DIR)) return [];

  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const dir = join(PACKAGES_DIR, d.name);
      // Try lingot.json first, fall back to legacy manifest.json
      let manifestPath = join(dir, 'lingot.json');
      if (!existsSync(manifestPath)) {
        manifestPath = join(dir, 'manifest.json');
        if (!existsSync(manifestPath)) return null;
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      return { dir, manifest };
    })
    .filter(Boolean);
}

function readFile(pkgDir, filename) {
  const filepath = join(pkgDir, filename);
  return existsSync(filepath) ? readFileSync(filepath, 'utf-8') : '';
}

function buildCombined(pkgDir) {
  const knowledge = readFile(pkgDir, 'knowledge.md');
  const rules = readFile(pkgDir, 'rules.xml');
  const examples = readFile(pkgDir, 'examples.yaml');

  return [
    knowledge,
    '',
    rules,
    '',
    '# Examples',
    '```yaml',
    examples,
    '```',
  ].join('\n');
}

export async function serve() {
  const server = new Server(
    { name: 'lingot-registry', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {} } }
  );

  // List all resources from installed packages
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const packages = loadPackages();
    const resources = [];

    for (const pkg of packages) {
      const name = pkg.manifest.name;

      // Combined resource
      resources.push({
        uri: `aipkg://local/${name}/combined`,
        name: `${name} (full context)`,
        description: pkg.manifest.description,
        mimeType: 'text/markdown',
      });

      // Granular resources
      resources.push({
        uri: `aipkg://local/${name}/knowledge`,
        name: `${name}/knowledge`,
        description: `Domain knowledge for ${name}`,
        mimeType: 'text/markdown',
      });
      resources.push({
        uri: `aipkg://local/${name}/rules`,
        name: `${name}/rules`,
        description: `Constraints and heuristics for ${name}`,
        mimeType: 'application/xml',
      });
      resources.push({
        uri: `aipkg://local/${name}/examples`,
        name: `${name}/examples`,
        description: `Few-shot examples for ${name}`,
        mimeType: 'text/yaml',
      });
    }

    return { resources };
  });

  // Read a specific resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const match = uri.match(/^aipkg:\/\/local\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    const [, pkgName, part] = match;
    const pkgDir = join(PACKAGES_DIR, pkgName);

    if (!existsSync(pkgDir)) {
      throw new Error(`Package not found: ${pkgName}`);
    }

    let content;
    let mimeType = 'text/plain';

    switch (part) {
      case 'combined':
        content = buildCombined(pkgDir);
        mimeType = 'text/markdown';
        break;
      case 'knowledge':
        content = readFile(pkgDir, 'knowledge.md');
        mimeType = 'text/markdown';
        break;
      case 'rules':
        content = readFile(pkgDir, 'rules.xml');
        mimeType = 'application/xml';
        break;
      case 'examples':
        content = readFile(pkgDir, 'examples.yaml');
        mimeType = 'text/yaml';
        break;
      default:
        throw new Error(`Unknown resource part: ${part}`);
    }

    return {
      contents: [{ uri, mimeType, text: content }],
    };
  });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'search_packages',
          description: 'Search locally installed Lingot intelligence blocks by topic, domain, or category. Returns verified, version-locked context packages with token counts. Use when you need authoritative reference material for a specific technology or domain.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search term to match against package names, descriptions, and keywords',
              },
              domain: {
                type: 'string',
                description: 'Filter by domain (e.g., payments, infrastructure)',
              },
              category: {
                type: 'string',
                description: 'Filter by category (e.g., developer, architect)',
              },
            },
          },
        },
        {
          name: 'get_package_context',
          description: 'Retrieve the full verified context of an Ingot intelligence block. Returns curated domain knowledge, strict heuristic constraints, and schema-validated code examples. Use to ensure syntax compliance with the latest API patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The package name (e.g., stripe-webhooks)',
              },
              part: {
                type: 'string',
                enum: ['combined', 'knowledge', 'rules', 'examples'],
                description: 'Which part to retrieve. Defaults to combined.',
              },
            },
            required: ['name'],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'search_packages') {
      const packages = loadPackages();
      const query = (args.query || '').toLowerCase();
      const domain = args.domain?.toLowerCase();
      const category = args.category?.toLowerCase();

      const results = packages.filter(pkg => {
        const m = pkg.manifest;
        const matchesQuery = !query ||
          m.name.includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.keywords?.some(k => k.toLowerCase().includes(query));
        const matchesDomain = !domain || m.domain?.toLowerCase() === domain;
        const matchesCategory = !category || m.category?.toLowerCase() === category;
        return matchesQuery && matchesDomain && matchesCategory;
      });

      const text = results.length === 0
        ? 'No packages found.'
        : results.map(pkg => {
            const m = pkg.manifest;
            return `${m.name}@${m.version} (${m.tokens.total} tokens)\n  ${m.description}\n  domain: ${m.domain} | category: ${m.category}\n  keywords: ${m.keywords?.join(', ')}`;
          }).join('\n\n');

      return { content: [{ type: 'text', text }] };
    }

    if (name === 'get_package_context') {
      const pkgName = args.name;
      const part = args.part || 'combined';
      const pkgDir = join(PACKAGES_DIR, pkgName);

      if (!existsSync(pkgDir)) {
        return { content: [{ type: 'text', text: `Package not found: ${pkgName}` }] };
      }

      let content;
      switch (part) {
        case 'combined':
          content = buildCombined(pkgDir);
          break;
        case 'knowledge':
          content = readFile(pkgDir, 'knowledge.md');
          break;
        case 'rules':
          content = readFile(pkgDir, 'rules.xml');
          break;
        case 'examples':
          content = readFile(pkgDir, 'examples.yaml');
          break;
        default:
          content = buildCombined(pkgDir);
      }

      return { content: [{ type: 'text', text: content }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running on stdio
}
