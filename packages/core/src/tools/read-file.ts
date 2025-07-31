/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { BaseTool, Icon, ToolLocation, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import {
  processSingleFileContent,
  getSpecificMimeType,
} from '../utils/fileUtils.js';
import { Config } from '../config/config.js';
import {
  recordFileOperationMetric,
  FileOperation,
} from '../telemetry/metrics.js';
import { testBenchAnalytics } from '../services/testBenchAnalytics.js';

/**
 * Parameters for the ReadFile tool
 */
export interface ReadFileToolParams {
  /**
   * The absolute path to the file to read
   */
  absolute_path: string;

  /**
   * The line number to start reading from (optional)
   */
  offset?: number;

  /**
   * The number of lines to read (optional)
   */
  limit?: number;
}

/**
 * Implementation of the ReadFile tool logic
 */
export class ReadFileTool extends BaseTool<ReadFileToolParams, ToolResult> {
  static readonly Name: string = 'read_file';

  constructor(private config: Config) {
    super(
      ReadFileTool.Name,
      'ReadFile',
      'Reads and returns the content of a specified file from the local filesystem. Handles text, images (PNG, JPG, GIF, WEBP, SVG, BMP), and PDF files. For text files, it can read specific line ranges.',
      Icon.FileSearch,
      {
        properties: {
          absolute_path: {
            description:
              "The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
            type: Type.STRING,
          },
          offset: {
            description:
              "Optional: For text files, the 0-based line number to start reading from. Requires 'limit' to be set. Use for paginating through large files.",
            type: Type.NUMBER,
          },
          limit: {
            description:
              "Optional: For text files, maximum number of lines to read. Use with 'offset' to paginate through large files. If omitted, reads the entire file (if feasible, up to a default limit).",
            type: Type.NUMBER,
          },
        },
        required: ['absolute_path'],
        type: Type.OBJECT,
      },
    );
  }

  validateToolParams(params: ReadFileToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}. You must provide an absolute path.`;
    }

    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(filePath)) {
      const directories = workspaceContext.getDirectories();
      return `File path must be within one of the workspace directories: ${directories.join(', ')}`;
    }
    if (params.offset !== undefined && params.offset < 0) {
      return 'Offset must be a non-negative number';
    }
    if (params.limit !== undefined && params.limit <= 0) {
      return 'Limit must be a positive number';
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldGeminiIgnoreFile(params.absolute_path)) {
      return `File path '${filePath}' is ignored by .geminiignore pattern(s).`;
    }

    return null;
  }

  getDescription(params: ReadFileToolParams): string {
    if (
      !params ||
      typeof params.absolute_path !== 'string' ||
      params.absolute_path.trim() === ''
    ) {
      return `Path unavailable`;
    }
    const relativePath = makeRelative(
      params.absolute_path,
      this.config.getTargetDir(),
    );
    return shortenPath(relativePath);
  }

  toolLocations(params: ReadFileToolParams): ToolLocation[] {
    return [{ path: params.absolute_path, line: params.offset }];
  }

  async execute(
    params: ReadFileToolParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    // Start analytics session if test-bench is enabled
    let analyticsSession = null;
    if (testBenchAnalytics.isAnalyticsEnabled()) {
      const relativePath = path.relative(this.config.getTargetDir(), params.absolute_path);
      const searchQuery = `ReadFile: ${relativePath}`;
      analyticsSession = testBenchAnalytics.startSearch(
        searchQuery,
        'read_files',
        this.config.getTargetDir()
      );
      
      // Add tool decision reasoning
      analyticsSession.setToolDecisionReason('CLI chose ReadFile tool for single file access');
      analyticsSession.setSearchParameters({
        absolute_path: params.absolute_path,
        offset: params.offset,
        limit: params.limit,
        target_directory: this.config.getTargetDir()
      });
      
      console.log(`🔍 TestBench: Tracking ReadFile operation for: ${relativePath}`);
      console.log(`🎯 TestBench: Tool selected because CLI requested specific file: ${relativePath}`);
    }

    const result = await processSingleFileContent(
      params.absolute_path,
      this.config.getTargetDir(),
      params.offset,
      params.limit,
    );

    if (result.error) {
      // Complete analytics session on error
      if (analyticsSession && testBenchAnalytics.isAnalyticsEnabled()) {
        analyticsSession.complete();
        console.log(`❌ TestBench: ReadFile failed: ${result.error}`);
      }
      
      return {
        llmContent: result.error, // The detailed error for LLM
        returnDisplay: result.returnDisplay || 'Error reading file', // User-friendly error
      };
    }

    const lines =
      typeof result.llmContent === 'string'
        ? result.llmContent.split('\n').length
        : undefined;
    const mimetype = getSpecificMimeType(params.absolute_path);
    recordFileOperationMetric(
      this.config,
      FileOperation.READ,
      lines,
      mimetype,
      path.extname(params.absolute_path),
    );

    // Complete analytics session if active
    if (analyticsSession && testBenchAnalytics.isAnalyticsEnabled()) {
      const relativePath = path.relative(this.config.getTargetDir(), params.absolute_path);
      let fileSize = 0;
      let fileLastModified = Date.now();
      
      try {
        const fs = require('fs');
        const stats = fs.statSync(params.absolute_path);
        fileSize = stats.size;
        fileLastModified = stats.mtime.getTime();
      } catch (error) {
        // Use defaults if stat fails
      }
      
      analyticsSession.addMatch({
        filePath: relativePath,
        lineNumber: params.offset || 0,
        matchText: `File: ${relativePath}`,
        matchReason: 'File read successfully',
        relevanceScore: 1.0,
        fileSize,
        fileLastModified
      });

      analyticsSession.setFilesScanned(1);
      analyticsSession.complete();
      
      console.log(`📊 TestBench: ReadFile completed - ${relativePath} (${fileSize} bytes, ${lines || 'N/A'} lines)`);
    }

    return {
      llmContent: result.llmContent || '',
      returnDisplay: result.returnDisplay || '',
    };
  }
}
