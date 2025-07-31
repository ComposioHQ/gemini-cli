/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { EOL } from 'os';
import { spawn } from 'child_process';
import { globStream } from 'glob';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { isGitRepository } from '../utils/gitUtils.js';
import { Config } from '../config/config.js';
import {
  testBenchAnalytics,
  MatchAnalytics,
} from '../services/testBenchAnalytics.js';

// --- Interfaces ---

/**
 * Parameters for the GrepTool
 */
export interface GrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory relative to root)
   */
  path?: string;

  /**
   * File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")
   */
  include?: string;
}

/**
 * Result object for a single grep match
 */
interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

// --- GrepLogic Class ---

/**
 * Implementation of the Grep tool logic (moved from CLI)
 */
export class GrepTool extends BaseTool<GrepToolParams, ToolResult> {
  static readonly Name = 'search_file_content'; // Keep static name

  constructor(private readonly config: Config) {
    super(
      GrepTool.Name,
      'SearchText',
      'Searches for a regular expression pattern within the content of files in a specified directory (or current working directory). Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers.',
      Icon.Regex,
      {
        properties: {
          pattern: {
            description:
              "The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
            type: Type.STRING,
          },
          path: {
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory.',
            type: Type.STRING,
          },
          include: {
            description:
              "Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).",
            type: Type.STRING,
          },
        },
        required: ['pattern'],
        type: Type.OBJECT,
      },
    );
  }

  // --- Validation Methods ---

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified (to search all directories).
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching all workspace directories
    if (!relativePath) {
      return null;
    }

    const targetPath = path.resolve(this.config.getTargetDir(), relativePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        `Path validation failed: Attempted path "${relativePath}" resolves outside the allowed workspace directories: ${directories.join(', ')}`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  validateToolParams(params: GrepToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern provided: ${params.pattern}. Error: ${getErrorMessage(error)}`;
    }

    // Only validate path if one is provided
    if (params.path) {
      try {
        this.resolveAndValidatePath(params.path);
      } catch (error) {
        return getErrorMessage(error);
      }
    }

    return null; // Parameters are valid
  }

  // --- Core Execution ---

  /**
   * Executes the grep search with the given parameters
   * @param params Parameters for the grep search
   * @returns Result of the grep search
   */
  async execute(
    params: GrepToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    // Start analytics session
    const session = testBenchAnalytics.startSearch(
      params.pattern,
      'grep',
      params.path || '.',
    );
    session.setPattern(params.pattern);

    const validationError = this.validateToolParams(params);
    if (validationError) {
      session.complete();
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Model provided invalid parameters. Error: ${validationError}`,
      };
    }

    try {
      const workspaceContext = this.config.getWorkspaceContext();
      const searchDirAbs = this.resolveAndValidatePath(params.path);
      const searchDirDisplay = params.path || '.';

      // Determine which directories to search
      let searchDirectories: readonly string[];
      if (searchDirAbs === null) {
        // No path specified - search all workspace directories
        searchDirectories = workspaceContext.getDirectories();
      } else {
        // Specific path provided - search only that directory
        searchDirectories = [searchDirAbs];
      }

      // Collect matches from all search directories
      let allMatches: GrepMatch[] = [];
      for (const searchDir of searchDirectories) {
        const matches = await this.performGrepSearchWithAnalytics({
          pattern: params.pattern,
          path: searchDir,
          include: params.include,
          signal,
          session,
        });

        // Add directory prefix if searching multiple directories
        if (searchDirectories.length > 1) {
          const dirName = path.basename(searchDir);
          matches.forEach((match) => {
            match.filePath = path.join(dirName, match.filePath);
          });
        }

        allMatches = allMatches.concat(matches);
      }

      let searchLocationDescription: string;
      if (searchDirAbs === null) {
        const numDirs = workspaceContext.getDirectories().length;
        searchLocationDescription =
          numDirs > 1
            ? `across ${numDirs} workspace directories`
            : `in the workspace directory`;
      } else {
        searchLocationDescription = `in path "${searchDirDisplay}"`;
      }

      if (allMatches.length === 0) {
        session.complete();
        const noMatchMsg = `No matches found for pattern "${params.pattern}" ${searchLocationDescription}${params.include ? ` (filter: "${params.include}")` : ''}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }

      // Group matches by file
      const matchesByFile = allMatches.reduce(
        (acc, match) => {
          const fileKey = match.filePath;
          if (!acc[fileKey]) {
            acc[fileKey] = [];
          }
          acc[fileKey].push(match);
          acc[fileKey].sort((a, b) => a.lineNumber - b.lineNumber);
          return acc;
        },
        {} as Record<string, GrepMatch[]>,
      );

      const matchCount = allMatches.length;
      const matchTerm = matchCount === 1 ? 'match' : 'matches';

      let llmContent = `Found ${matchCount} ${matchTerm} for pattern "${params.pattern}" ${searchLocationDescription}${params.include ? ` (filter: "${params.include}")` : ''}:
---
`;

      for (const filePath in matchesByFile) {
        llmContent += `File: ${filePath}\n`;
        matchesByFile[filePath].forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
        llmContent += '---\n';
      }

      // Complete analytics session
      session.complete();

      return {
        llmContent: llmContent.trim(),
        returnDisplay: `Found ${matchCount} ${matchTerm}`,
      };
    } catch (error) {
      session.complete();
      console.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  // --- Grep Implementation Logic ---

  /**
   * Checks if a command is available in the system's PATH.
   * @param {string} command The command name (e.g., 'git', 'grep').
   * @returns {Promise<boolean>} True if the command is available, false otherwise.
   */
  private isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const checkCommand = process.platform === 'win32' ? 'where' : 'command';
      const checkArgs =
        process.platform === 'win32' ? [command] : ['-v', command];
      try {
        const child = spawn(checkCommand, checkArgs, {
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Parses the standard output of grep-like commands (git grep, system grep).
   * Expects format: filePath:lineNumber:lineContent
   * Handles colons within file paths and line content correctly.
   * @param {string} output The raw stdout string.
   * @param {string} basePath The absolute directory the search was run from, for relative paths.
   * @returns {GrepMatch[]} Array of match objects.
   */
  private parseGrepOutput(output: string, basePath: string): GrepMatch[] {
    const results: GrepMatch[] = [];
    if (!output) return results;

    const lines = output.split(EOL); // Use OS-specific end-of-line

    for (const line of lines) {
      if (!line.trim()) continue;

      // Find the index of the first colon.
      const firstColonIndex = line.indexOf(':');
      if (firstColonIndex === -1) continue; // Malformed

      // Find the index of the second colon, searching *after* the first one.
      const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
      if (secondColonIndex === -1) continue; // Malformed

      // Extract parts based on the found colon indices
      const filePathRaw = line.substring(0, firstColonIndex);
      const lineNumberStr = line.substring(
        firstColonIndex + 1,
        secondColonIndex,
      );
      const lineContent = line.substring(secondColonIndex + 1);

      const lineNumber = parseInt(lineNumberStr, 10);

      if (!isNaN(lineNumber)) {
        const absoluteFilePath = path.resolve(basePath, filePathRaw);
        const relativeFilePath = path.relative(basePath, absoluteFilePath);

        results.push({
          filePath: relativeFilePath || path.basename(absoluteFilePath),
          lineNumber,
          line: lineContent,
        });
      }
    }
    return results;
  }

  /**
   * Gets a description of the grep operation
   * @param params Parameters for the grep operation
   * @returns A string describing the grep
   */
  getDescription(params: GrepToolParams): string {
    let description = `'${params.pattern}'`;
    if (params.include) {
      description += ` in ${params.include}`;
    }
    if (params.path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        params.path,
      );
      if (resolvedPath === this.config.getTargetDir() || params.path === '.') {
        description += ` within ./`;
      } else {
        const relativePath = makeRelative(
          resolvedPath,
          this.config.getTargetDir(),
        );
        description += ` within ${shortenPath(relativePath)}`;
      }
    } else {
      // When no path is specified, indicate searching all workspace directories
      const workspaceContext = this.config.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();
      if (directories.length > 1) {
        description += ` across all workspace directories`;
      }
    }
    return description;
  }

  /**
   * Performs the actual search using the prioritized strategies.
   * @param options Search options including pattern, absolute path, and include glob.
   * @returns A promise resolving to an array of match objects.
   */
  private async performGrepSearch(options: {
    pattern: string;
    path: string; // Expects absolute path
    include?: string;
    signal: AbortSignal;
  }): Promise<GrepMatch[]> {
    const { pattern, path: absolutePath, include } = options;
    let strategyUsed = 'none';

    try {
      // --- Strategy 1: git grep ---
      const isGit = isGitRepository(absolutePath);
      const gitAvailable = isGit && (await this.isCommandAvailable('git'));

      if (gitAvailable) {
        strategyUsed = 'git grep';
        const gitArgs = [
          'grep',
          '--untracked',
          '-n',
          '-E',
          '--ignore-case',
          pattern,
        ];
        if (include) {
          gitArgs.push('--', include);
        }

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('git', gitArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
            child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
            child.on('error', (err) =>
              reject(new Error(`Failed to start git grep: ${err.message}`)),
            );
            child.on('close', (code) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks).toString('utf8');
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else
                reject(
                  new Error(`git grep exited with code ${code}: ${stderrData}`),
                );
            });
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (gitError: unknown) {
          console.debug(
            `GrepLogic: git grep failed: ${getErrorMessage(gitError)}. Falling back...`,
          );
        }
      }

      // --- Strategy 2: System grep ---
      const grepAvailable = await this.isCommandAvailable('grep');
      if (grepAvailable) {
        strategyUsed = 'system grep';
        const grepArgs = ['-r', '-n', '-H', '-E'];
        const commonExcludes = ['.git', 'node_modules', 'bower_components'];
        commonExcludes.forEach((dir) => grepArgs.push(`--exclude-dir=${dir}`));
        if (include) {
          grepArgs.push(`--include=${include}`);
        }
        grepArgs.push(pattern);
        grepArgs.push('.');

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('grep', grepArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            const onData = (chunk: Buffer) => stdoutChunks.push(chunk);
            const onStderr = (chunk: Buffer) => {
              const stderrStr = chunk.toString();
              // Suppress common harmless stderr messages
              if (
                !stderrStr.includes('Permission denied') &&
                !/grep:.*: Is a directory/i.test(stderrStr)
              ) {
                stderrChunks.push(chunk);
              }
            };
            const onError = (err: Error) => {
              cleanup();
              reject(new Error(`Failed to start system grep: ${err.message}`));
            };
            const onClose = (code: number | null) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks)
                .toString('utf8')
                .trim();
              cleanup();
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else {
                if (stderrData)
                  reject(
                    new Error(
                      `System grep exited with code ${code}: ${stderrData}`,
                    ),
                  );
                else resolve(''); // Exit code > 1 but no stderr, likely just suppressed errors
              }
            };

            const cleanup = () => {
              child.stdout.removeListener('data', onData);
              child.stderr.removeListener('data', onStderr);
              child.removeListener('error', onError);
              child.removeListener('close', onClose);
              if (child.connected) {
                child.disconnect();
              }
            };

            child.stdout.on('data', onData);
            child.stderr.on('data', onStderr);
            child.on('error', onError);
            child.on('close', onClose);
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (grepError: unknown) {
          console.debug(
            `GrepLogic: System grep failed: ${getErrorMessage(grepError)}. Falling back...`,
          );
        }
      }

      // --- Strategy 3: Pure JavaScript Fallback ---
      console.debug(
        'GrepLogic: Falling back to JavaScript grep implementation.',
      );
      strategyUsed = 'javascript fallback';
      const globPattern = include ? include : '**/*';
      const ignorePatterns = [
        '.git/**',
        'node_modules/**',
        'bower_components/**',
        '.svn/**',
        '.hg/**',
      ]; // Use glob patterns for ignores here

      const filesStream = globStream(globPattern, {
        cwd: absolutePath,
        dot: true,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
        signal: options.signal,
      });

      const regex = new RegExp(pattern, 'i');
      const allMatches: GrepMatch[] = [];

      for await (const filePath of filesStream) {
        const fileAbsolutePath = filePath as string;
        try {
          const content = await fsPromises.readFile(fileAbsolutePath, 'utf8');
          const lines = content.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              allMatches.push({
                filePath:
                  path.relative(absolutePath, fileAbsolutePath) ||
                  path.basename(fileAbsolutePath),
                lineNumber: index + 1,
                line,
              });
            }
          });
        } catch (readError: unknown) {
          // Ignore errors like permission denied or file gone during read
          if (!isNodeError(readError) || readError.code !== 'ENOENT') {
            console.debug(
              `GrepLogic: Could not read/process ${fileAbsolutePath}: ${getErrorMessage(readError)}`,
            );
          }
        }
      }

      return allMatches;
    } catch (error: unknown) {
      console.error(
        `GrepLogic: Error in performGrepSearch (Strategy: ${strategyUsed}): ${getErrorMessage(error)}`,
      );
      throw error; // Re-throw
    }
  }

  /**
   * Enhanced version of performGrepSearch with detailed analytics tracking
   */
  private async performGrepSearchWithAnalytics(options: {
    pattern: string;
    path: string;
    include?: string;
    signal: AbortSignal;
    session: import('../services/testBenchAnalytics.js').SearchSession;
  }): Promise<GrepMatch[]> {
    const { session } = options;
    const _startTime = performance.now();
    let filesScanned = 0;
    const _strategyUsed = 'none';

    try {
      // Call the original method
      const matches = await this.performGrepSearch(options);

      // Enhanced analytics processing
      if (session.isActive()) {
        // Count files in directory for analytics
        try {
          const globPattern = options.include || '**/*';
          const ignorePatterns = [
            '.git/**',
            'node_modules/**',
            'bower_components/**',
          ];
          const filesStream = globStream(globPattern, {
            cwd: options.path,
            dot: true,
            ignore: ignorePatterns,
            absolute: true,
            nodir: true,
          });

          for await (const _filePath of filesStream) {
            filesScanned++;
          }
        } catch (error) {
          console.debug('Error counting files for analytics:', error);
        }

        session.setFilesScanned(filesScanned);

        // Process each match with detailed analytics
        for (const match of matches) {
          const matchAnalytics: MatchAnalytics =
            await this.createMatchAnalytics(
              match,
              options.pattern,
              options.path,
            );
          session.addMatch(matchAnalytics);
        }

        // Add ranking factors
        this.addSearchRankingFactors(session, options, matches, filesScanned);
      }

      return matches;
    } catch (error) {
      console.error('Error in performGrepSearchWithAnalytics:', error);
      throw error;
    }
  }

  /**
   * Creates detailed analytics for a single match
   */
  private async createMatchAnalytics(
    match: GrepMatch,
    pattern: string,
    searchPath: string,
  ): Promise<MatchAnalytics> {
    let fileSize = 0;
    let fileLastModified = 0;
    let contextBefore = '';
    let contextAfter = '';

    try {
      const fullPath = path.resolve(searchPath, match.filePath);
      const stats = await fsPromises.stat(fullPath);
      fileSize = stats.size;
      fileLastModified = stats.mtimeMs;

      // Get context lines for better understanding
      const content = await fsPromises.readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      const lineIndex = match.lineNumber - 1;

      contextBefore = lines
        .slice(Math.max(0, lineIndex - 2), lineIndex)
        .join('\n');
      contextAfter = lines
        .slice(lineIndex + 1, Math.min(lines.length, lineIndex + 3))
        .join('\n');
    } catch (error) {
      console.debug(`Could not get file stats for ${match.filePath}:`, error);
    }

    // Calculate relevance score based on various factors
    const relevanceScore = this.calculateRelevanceScore(match, pattern);

    return {
      filePath: match.filePath,
      lineNumber: match.lineNumber,
      matchText: match.line,
      contextBefore,
      contextAfter,
      relevanceScore,
      matchReason: this.getMatchReason(match, pattern),
      fileSize,
      fileLastModified,
    };
  }

  /**
   * Calculate relevance score for a match (0-1)
   */
  private calculateRelevanceScore(match: GrepMatch, pattern: string): number {
    let score = 0.5; // Base score

    // Exact match bonus
    if (match.line.toLowerCase().includes(pattern.toLowerCase())) {
      score += 0.2;
    }

    // Line length factor (shorter lines with matches are often more relevant)
    const lineLength = match.line.trim().length;
    if (lineLength < 100) score += 0.1;
    if (lineLength < 50) score += 0.1;

    // Position factor (matches at beginning of line are often more relevant)
    const trimmedLine = match.line.trim();
    const matchIndex = trimmedLine.toLowerCase().indexOf(pattern.toLowerCase());
    if (matchIndex < 10) score += 0.1;

    // File extension bonus
    const ext = path.extname(match.filePath).toLowerCase();
    if (['.md', '.txt', '.js', '.ts', '.py', '.java'].includes(ext)) {
      score += 0.1;
    }

    return Math.min(1, score);
  }

  /**
   * Determine why this particular match was selected
   */
  private getMatchReason(match: GrepMatch, pattern: string): string {
    const reasons = [];

    if (match.line.toLowerCase().includes(pattern.toLowerCase())) {
      reasons.push('exact pattern match');
    }

    const regex = new RegExp(pattern, 'i');
    if (regex.test(match.line)) {
      reasons.push('regex pattern match');
    }

    const ext = path.extname(match.filePath);
    if (ext) {
      reasons.push(`found in ${ext} file`);
    }

    if (match.lineNumber < 10) {
      reasons.push('near file beginning');
    }

    return reasons.join(', ') || 'pattern match';
  }

  /**
   * Add ranking factors to help understand search effectiveness
   */
  private addSearchRankingFactors(
    session: import('../services/testBenchAnalytics.js').SearchSession,
    options: { pattern: string; path: string; include?: string },
    matches: GrepMatch[],
    filesScanned: number,
  ) {
    if (!session.isActive()) return;

    // Pattern complexity factor
    const patternComplexity = this.calculatePatternComplexity(options.pattern);
    session.addRankingFactor({
      factor: 'Pattern Complexity',
      weight: 0.3,
      value: patternComplexity,
      impact: patternComplexity * 0.3,
      explanation: `Pattern "${options.pattern}" has ${patternComplexity > 0.5 ? 'high' : 'low'} complexity (${patternComplexity.toFixed(2)})`,
    });

    // Search scope factor
    const scopeFactor = filesScanned > 100 ? 1.0 : filesScanned / 100;
    session.addRankingFactor({
      factor: 'Search Scope',
      weight: 0.2,
      value: scopeFactor,
      impact: scopeFactor * 0.2,
      explanation: `Searched ${filesScanned} files (scope factor: ${scopeFactor.toFixed(2)})`,
    });

    // Result density factor
    const resultDensity = filesScanned > 0 ? matches.length / filesScanned : 0;
    session.addRankingFactor({
      factor: 'Result Density',
      weight: 0.4,
      value: resultDensity,
      impact: resultDensity * 0.4,
      explanation: `Found ${matches.length} matches in ${filesScanned} files (${(resultDensity * 100).toFixed(2)}% hit rate)`,
    });

    // File filter factor
    if (options.include) {
      session.addRankingFactor({
        factor: 'File Filter',
        weight: 0.1,
        value: 1.0,
        impact: 0.1,
        explanation: `Applied file filter: ${options.include}`,
      });
    }
  }

  /**
   * Calculate pattern complexity (0-1, where 1 is most complex)
   */
  private calculatePatternComplexity(pattern: string): number {
    let complexity = 0;

    // Regex special characters
    const regexChars = /[.*+?^${}()|[\]\\]/g;
    const regexMatches = pattern.match(regexChars);
    if (regexMatches) {
      complexity += Math.min(regexMatches.length * 0.1, 0.5);
    }

    // Length factor
    complexity += Math.min(pattern.length * 0.01, 0.3);

    // Case sensitivity
    if (
      pattern !== pattern.toLowerCase() &&
      pattern !== pattern.toUpperCase()
    ) {
      complexity += 0.1;
    }

    // Word boundaries and special patterns
    if (
      pattern.includes('\\b') ||
      pattern.includes('\\w') ||
      pattern.includes('\\d')
    ) {
      complexity += 0.2;
    }

    return Math.min(complexity, 1);
  }
}
