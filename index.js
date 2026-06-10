import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "django-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const BASE = "https://docs.djangoproject.com/en/6.0/_sources";

// ─── LRU Cache ───────────────────────────────────────────────────────────────

const CACHE_MAX = 50;
const DOC_TTL = 60 * 60 * 1000; // 1 hour for doc pages
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

function cacheSet(key, data, ttl) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, ts: Date.now(), ttl });
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

async function fetchText(url, ttl = DOC_TTL) {
  const cached = cacheGet(url);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  cacheSet(url, text, ttl);
  return text;
}

// ─── Markdown / reST Cleaner ─────────────────────────────────────────────────

function cleanText(text) {
  let out = text;
  
  // Remove .. _anchor: tags
  out = out.replace(/\.\.\s+_[a-zA-Z0-9_-]+:\n/g, "");

  // Remove module directives that only serve Sphinx context
  out = out.replace(/\.\.\s+(currentmodule|module)::\s*(.*)/g, "");

  // Convert Sphinx/reST notes and warnings to markdown blockquotes
  out = out.replace(/\.\.\s+(note|warning|versionadded|versionchanged|deprecated)::\s*(.*)/g, (_, type, content) => {
    return `> **${type.toUpperCase()}:** ${content.trim()}`;
  });
  
  // Strip code blocks markers to standard markdown fences
  out = out.replace(/\.\.\s+code-block::\s*([a-zA-Z0-9_-]+)?.*/g, "```$1");
  
  // Strip roles like :class:`Model`, :func:`render` -> `Model`, `render`
  out = out.replace(/:[a-zA-Z0-9_-]+:`([^`]+)`/g, "`$1`");

  // Convert headings
  const lines = out.split('\n');
  const processed = [];
  const levels = {};
  let currentLevel = 1;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Check for overline + heading + underline
    if (/^[=\-~^\."']{3,}$/.test(line.trim())) {
      const nextLine = lines[i+1];
      const nextNextLine = lines[i+2];
      if (nextLine && nextNextLine && nextNextLine.trim() === line.trim() && nextLine.trim().length > 0) {
        const char = line.trim()[0];
        if (!levels[char]) levels[char] = currentLevel++;
        processed.push('#'.repeat(levels[char]) + ' ' + nextLine.trim());
        i += 2;
        continue;
      }
    }

    // Check for heading + underline
    const nextLine = lines[i+1];
    if (nextLine && nextLine.length >= line.trim().length && line.trim().length > 0 && /^[=\-~^\."']{3,}$/.test(nextLine.trim())) {
      if (!line.match(/^\s/)) { // Headings shouldn't be indented
        const char = nextLine.trim()[0];
        if (!levels[char]) levels[char] = currentLevel++;
        processed.push('#'.repeat(levels[char]) + ' ' + line.trim());
        i++;
        continue;
      }
    }
    
    processed.push(line);
  }
  out = processed.join('\n');

  // Collapse 3+ blank lines
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

// ─── Section Extractor ───────────────────────────────────────────────────────

function extractSection(md, sectionName) {
  const lines = md.split("\n");
  const target = sectionName.toLowerCase().trim();
  let capturing = false;
  let captureLevel = 0;
  const result = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].toLowerCase().trim();
      if (!capturing && title.includes(target)) {
        capturing = true;
        captureLevel = level;
        result.push(line);
        continue;
      }
      if (capturing && level <= captureLevel) {
        break; // Next heading of equal or higher level — stop
      }
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result.length > 0 ? result.join("\n").trim() : null;
}

// ─── TocTree Extractor ───────────────────────────────────────────────────────

function parseTocTree(text, basePath) {
  const lines = text.split("\n");
  let capturing = false;
  const paths = [];

  for (const line of lines) {
    if (line.match(/^\.\.\s+toctree::/)) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (line.trim() === "" || line.match(/^\s+:/)) {
        // Skip empty lines or options like `:maxdepth: 2`
        continue;
      }
      if (line.match(/^\S/)) {
        // End of indented block
        capturing = false;
        continue;
      }
      const target = line.trim();
      if (target) {
        let fullPath = target;
        if (basePath && basePath !== "") {
          fullPath = `${basePath}/${target}`;
        }
        paths.push(fullPath);
      }
    }
  }
  return paths;
}

// ─── Best Practices Content ──────────────────────────────────────────────────

const BEST_PRACTICES = {
  architecture: `## Architecture
- Use "Fat Models, Thin Views". Put business logic on model methods or managers, not in views.
- Keep apps small, focused, and reusable. A Django project is a collection of apps.
- Use environment variables (via packages like \`django-environ\`) for secrets and settings.
- Separate settings for development, testing, and production.`,

  models: `## Models & Database
- Use \`select_related()\` and \`prefetch_related()\` to avoid N+1 query problems.
- Don't use \`null=True\` on string-based fields (\`CharField\`, \`TextField\`); use \`blank=True\` instead.
- Index fields that you frequently filter or sort by using \`db_index=True\` or \`indexes\`.
- Keep the \`__str__\` method simple and robust (avoiding database queries inside it).`,

  views: `## Views & URLs
- Name your URL patterns using the \`name\` argument for reverse lookups.
- Namespace your URLs at the app level.
- Prefer Class-Based Views (CBVs) for standard CRUD operations, but don't overcomplicate them with deep inheritance. Use Function-Based Views (FBVs) for simple or highly custom logic.
- Return appropriate HTTP status codes (e.g., 404 via \`get_object_or_404\`).`,

  templates: `## Templates
- Keep logic out of templates. Use custom template tags and filters for complex presentation logic.
- Use \`{% url %}\` instead of hardcoding URLs.
- Make use of template inheritance (\`{% extends %}\` and \`{% block %}\`) to DRY your templates.`,

  security: `## Security
- Never expose \`SECRET_KEY\` or \`DEBUG=True\` in production.
- Rely on Django's built-in CSRF protection for all POST requests.
- Use Django's authentication and authorization framework; do not write your own.
- Always use Django's ORM or parameterized queries to prevent SQL injection.`
};

const ALL_TOPICS = Object.keys(BEST_PRACTICES);

// ─── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_django_docs",
      description: "Discovers available documentation sub-pages by parsing the TOC of a given path. Defaults to root.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional path to list sub-pages for (e.g., 'topics', 'ref', 'howto'). Leave empty for the root."
          }
        }
      }
    },
    {
      name: "read_django_docs",
      description: "Fetches and returns the content of a specific Django documentation page.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The doc page path (e.g., 'topics/db/models', 'ref/models/querysets'). Required."
          },
          section: {
            type: "string",
            description: "Optional heading name to extract only that section (e.g., 'Fields', 'Meta options'). Drastically reduces tokens."
          }
        },
        required: ["path"]
      }
    },
    {
      name: "django_best_practices",
      description: "Returns a static set of Django best practices. Topics: 'architecture', 'models', 'views', 'templates', 'security'. Returns all if omitted.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: `Optional topic filter: ${ALL_TOPICS.join(", ")}.`
          }
        }
      }
    }
  ]
}));

// ─── Tool Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── list_django_docs ──────────────────────────────────────────────────────
  if (name === "list_django_docs") {
    let rawPath = (args?.path || "").replace(/^\/+/, "").replace(/\.txt$/, "");
    if (!rawPath) rawPath = "contents"; // Root index in Sphinx/Django

    // Usually directories have an index.txt, but sometimes the file itself has the toctree
    // E.g., 'topics' -> might be 'topics.txt' or 'topics/index.txt'
    // Django typically uses 'topics/index.txt' for directories
    
    // We try the provided path as-is (with .txt), if 404, we try path/index.txt
    let url = `${BASE}/${rawPath}.txt`;
    let text = "";
    
    try {
      text = await fetchText(url);
    } catch (e1) {
      if (!rawPath.endsWith("index")) {
        try {
          url = `${BASE}/${rawPath}/index.txt`;
          text = await fetchText(url);
        } catch (e2) {
          return {
            content: [{ type: "text", text: `Failed to fetch index for path '${rawPath}': ${e1.message} and ${e2.message}` }],
            isError: true,
          };
        }
      } else {
        return {
          content: [{ type: "text", text: `Failed to fetch index for path '${rawPath}': ${e1.message}` }],
          isError: true,
        };
      }
    }

    let basePath = rawPath === "contents" ? "" : rawPath.replace(/\/index$/, "");
    const subPaths = parseTocTree(text, basePath);

    if (subPaths.length === 0) {
      return {
        content: [{ type: "text", text: `No sub-pages found in '.. toctree::' at ${url}. It might be a leaf page. Try using read_django_docs on this path.` }]
      };
    }

    const lines = subPaths.map(p => `- ${p}`);
    return {
      content: [{ type: "text", text: `Found ${subPaths.length} sub-pages at ${url}:\n\n${lines.join("\n")}` }]
    };
  }

  // ── read_django_docs ──────────────────────────────────────────────────────
  if (name === "read_django_docs") {
    let path = (args?.path || "").replace(/^\/+/, "").replace(/\.txt$/, "");
    if (!path) {
      return {
        content: [{ type: "text", text: 'Missing required "path" parameter. Use list_django_docs to discover available paths.' }],
        isError: true,
      };
    }

    // Try path.txt, then path/index.txt
    let url = `${BASE}/${path}.txt`;
    let text = "";
    try {
      text = await fetchText(url);
    } catch (e1) {
      if (!path.endsWith("index")) {
        try {
          url = `${BASE}/${path}/index.txt`;
          text = await fetchText(url);
        } catch (e2) {
          return {
            content: [{ type: "text", text: `Failed to fetch doc: ${url}\nBoth ${path}.txt and ${path}/index.txt resulted in errors. Use list_django_docs to find valid paths.` }],
            isError: true,
          };
        }
      } else {
        return {
          content: [{ type: "text", text: `Failed to fetch doc: ${url}\n${e1.message}` }],
          isError: true,
        };
      }
    }

    let cleaned = cleanText(text);
    
    const section = args?.section;
    if (section) {
      const extracted = extractSection(cleaned, section);
      if (extracted) {
        cleaned = extracted;
      } else {
        cleaned = `> Section "${section}" not found on this page.\n\n${cleaned}`;
      }
    }

    return {
      content: [{ type: "text", text: `Source: ${url}\n\n${cleaned}` }]
    };
  }

  // ── django_best_practices ─────────────────────────────────────────────────
  if (name === "django_best_practices") {
    const topic = args?.topic?.toLowerCase();
    if (topic && BEST_PRACTICES[topic]) {
      return {
        content: [{ type: "text", text: `# Django Best Practices — ${topic}\n\n${BEST_PRACTICES[topic]}` }]
      };
    }
    const all = Object.values(BEST_PRACTICES).join("\n\n---\n\n");
    return {
      content: [{ type: "text", text: `# Django Best Practices\n\n${all}` }]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Django MCP Server running");
}

main();
