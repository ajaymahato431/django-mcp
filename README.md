# Django MCP Server

A token-optimized Model Context Protocol (MCP) server for retrieving Django documentation. This tool provides AI agents with up-to-date, accurate context regarding Django 6.0 to help assist you in developing robust Python applications.

## Features

This MCP server provides the following tools to the AI:
- **`list_django_docs`**: Lists all available Django documentation sections and pages.
- **`read_django_docs`**: Reads the detailed content of a specific Django documentation page.
- **`django_best_practices`**: Provides token-optimized summaries of best practices for building applications with Django.

## Prerequisites

- **Node.js** (v18 or higher recommended)
- **npm** (comes with Node.js)

## Installation

1. Navigate to the project directory:
   ```bash
   cd /path/to/django-mcp
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

## Integrate into Your IDE

You can connect this tool to your IDE so your AI agents can read Django documentation dynamically.

**For Antigravity:**
Edit `~/.gemini/config/mcp_config.json` (or `C:\Users\<User>\.gemini\config\mcp_config.json` on Windows)

**For VS Code (Cline/Roo):**
Edit your `cline_mcp_settings.json`

Add the following block to your configuration file, ensuring you use the absolute path to where you saved the `django-mcp` folder:

```json
{
  "mcpServers": {
    "django-docs": {
      "command": "node",
      "args": [
        "c:/laragon/www/mcp-server/django-mcp/index.js"
      ]
    }
  }
}
```

*(Note: Adjust the path `c:/laragon/www/mcp-server/django-mcp/index.js` to match your actual absolute path if different.)*

### How the AI will use this

Once configured, simply instruct your AI assistant. For example:
- *"Read the Django documentation page on 'topics/db/models' and help me create a model."*
- *"Can you list the Django best practices for architecture?"*
