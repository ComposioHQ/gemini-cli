# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Development Commands

**Build and Development:**
- `npm run build` - Build the project
- `npm run bundle` - Bundle the CLI for distribution
- `npm start` - Start the CLI in development mode
- `npm run debug` - Start with debugging enabled

**Testing:**
- `npm test` - Run all tests across workspaces
- `npm run test:ci` - Run tests in CI mode with scripts tests
- `npm run test:e2e` - Run end-to-end tests
- `npm run test:integration:all` - Run all integration tests (none, docker, podman)
- `npm run test:scripts` - Run script-specific tests

**Code Quality:**
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Auto-fix lint issues
- `npm run lint:ci` - Lint with zero warnings for CI
- `npm run format` - Format code with Prettier
- `npm run typecheck` - Run TypeScript type checking
- `npm run preflight` - Full validation suite (clean, install, format, lint, build, typecheck, test)

**Individual Test Execution:**
- Use vitest directly: `npx vitest run path/to/test.test.ts`
- For specific packages: `npm run test --workspace=packages/cli`

## Architecture Overview

This is a monorepo workspace containing three main packages:

### packages/cli/
The main CLI interface built with React Ink for terminal UI. Key components:
- **UI Layer**: React components in `src/ui/` for terminal rendering
- **Commands**: Slash commands in `src/ui/commands/` (e.g., `/auth`, `/theme`, `/help`)
- **Services**: Command loading and processing in `src/services/`
- **Configuration**: Auth, settings, and extension config in `src/config/`

### packages/core/
Core functionality and business logic:
- **AI Integration**: Gemini API client and chat handling in `src/core/`
- **Tools System**: File operations, shell, web search, MCP integration in `src/tools/`
- **Services**: Git, file discovery, shell execution in `src/services/`
- **Memory**: Context and memory management
- **Telemetry**: Usage tracking and metrics

### packages/vscode-ide-companion/
VS Code extension for IDE integration with the CLI.

## Key Technical Patterns

**Monorepo Structure**: Uses npm workspaces with shared dependencies and cross-package imports.

**React Terminal UI**: Built with Ink library for rich terminal interfaces. Components use hooks and context for state management.

**Tool Architecture**: Extensible tool system where each tool (file operations, shell, web search) implements a consistent interface. Tools can be:
- Built-in tools in `packages/core/src/tools/`
- MCP (Model Context Protocol) servers for external integration
- Custom extensions

**Authentication Flow**: Supports multiple auth methods (Google OAuth, API keys, Vertex AI) with persistent token storage.

**Configuration System**: Layered config with user settings, extension configs, and runtime overrides.

**Memory System**: Context-aware memory management for maintaining conversation state and code understanding across sessions.

**Sandbox Support**: Optional containerized execution environment (Docker/Podman) for secure command execution.

## Development Workflow

1. **Setup**: Run `npm ci` to install dependencies
2. **Development**: Use `npm start` for live development
3. **Testing**: Always run individual tests before `npm run preflight`
4. **Pre-commit**: Run `npm run preflight` - this is the full validation pipeline used in CI
5. **Integration**: Test with various sandbox modes if working on shell/file tools

## Testing Framework

Uses **Vitest** throughout the codebase:
- Unit tests co-located with source files (`.test.ts/.test.tsx`)
- Integration tests in `integration-tests/` directory
- Mocking with `vi.mock()` for external dependencies
- React component testing with `ink-testing-library`

## Important File Locations

- **Main entry**: `packages/cli/src/gemini.tsx` - Main CLI app component
- **Tool registry**: `packages/core/src/tools/tool-registry.ts` - Central tool management
- **Configuration**: `packages/core/src/config/config.ts` - Core config management
- **AI Client**: `packages/core/src/core/client.ts` - Gemini API integration
- **Build scripts**: `scripts/` - Custom build and deployment scripts

## Extensions and MCP

The CLI supports extensions through:
- **File-based commands**: Custom commands loaded from filesystem
- **MCP servers**: External tools via Model Context Protocol
- **Built-in extensions**: Core functionality that can be extended

MCP integration allows connecting external tools and services to the CLI's conversation context.