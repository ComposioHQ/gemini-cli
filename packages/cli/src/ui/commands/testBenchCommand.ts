/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandContext, SlashCommand, CommandKind, MessageActionReturn } from './types.js';
import { testBenchAnalytics, TestBenchConfig } from '@google/gemini-cli-core';
import { UrlContentDownloader } from '@google/gemini-cli-core';
import path from 'path';
import fs from 'fs/promises';

async function handleTestBenchCommand(
  context: CommandContext,
  args: string,
): Promise<MessageActionReturn> {
  const parts = args.split(/\s+/).filter(Boolean);
  const subCommand = parts[0]?.toLowerCase();

  switch (subCommand) {
    case 'enable':
      return await handleEnable(context, parts.slice(1));
    case 'download':
      return await handleDownload(context, parts.slice(1));
    case 'test':
      return await handleTest(context, parts.slice(1));
    case 'disable':
      return await handleDisable(context);
    case 'status':
      return await handleStatus(context);
    case 'setpath':
      return await handleSetPath(context, parts.slice(1));
    case 'report':
      return await handleReport(context);
    case 'export':
      return await handleExport(context, parts.slice(1));
    case 'clear':
      return await handleClear(context);
    default:
      return await handleHelp(context);
  }
}

async function handleEnable(context: CommandContext, args: string[]): Promise<MessageActionReturn> {
  // Parse arguments for --input_folder flag
  let docsPath: string | null = null;
  let urlSource: string | null = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input_folder' && i + 1 < args.length) {
      docsPath = args[i + 1];
    } else if (args[i].startsWith('http://') || args[i].startsWith('https://')) {
      urlSource = args[i];
    } else if (!docsPath && !urlSource) {
      // First non-flag argument is treated as path
      docsPath = args[i];
    }
  }
  
  // Default to current input-docs if nothing specified
  if (!docsPath && !urlSource) {
    docsPath = path.join(process.cwd(), 'input-docs');
  }
  
  let message = '';
  
  try {
    if (urlSource) {
      // URL mode - validate URL and set up for download
      if (!urlSource.endsWith('llms.txt') && !urlSource.includes('llms.txt')) {
        message = '❌ Error: URL must point to an llms.txt file.\n' +
                  '💡 Example: /testbench enable https://example.com/llms.txt';
        return { type: 'message', messageType: 'error', content: message };
      }
      
      const downloadPath = path.join(process.cwd(), 'downloaded-docs');
      const config: TestBenchConfig = {
        mode: 'url',
        source: urlSource,
        downloadPath
      };
      
      testBenchAnalytics.setConfig(config);
      testBenchAnalytics.enableAnalytics(true);
      
      message = `✅ Test-bench analytics enabled in URL mode!\n` +
                `🌐 Source URL: ${urlSource}\n` +
                `📁 Download path: ${downloadPath}\n` +
                `🔍 Use "/testbench download" to fetch content from llms.txt\n\n` +
                `Next steps:\n` +
                `  1. /testbench download    - Download content from URLs\n` +
                `  2. Ask questions about the content\n` +
                `  3. /testbench report      - View analytics`;
      
    } else if (docsPath) {
      // Folder mode - validate directory exists
      const stats = await fs.stat(docsPath);
      if (!stats.isDirectory()) {
        message = '❌ Error: Specified path is not a directory.';
        return { type: 'message', messageType: 'error', content: message };
      }

      const config: TestBenchConfig = {
        mode: 'folder',
        source: docsPath
      };
      
      testBenchAnalytics.setConfig(config);
      testBenchAnalytics.enableAnalytics(true);
      
      message = `✅ Test-bench analytics enabled in folder mode!\n` +
                `📁 Document folder: ${docsPath}\n` +
                `🔍 All search operations will now be tracked with detailed analytics.\n\n` +
                `Available commands:\n` +
                `  /testbench status     - Show current status\n` +
                `  /testbench report     - Generate analytics report\n` +
                `  /testbench export     - Export analytics data\n` +
                `  /testbench disable    - Disable analytics`;
    }
    
  } catch (error) {
    message = `❌ Error: Cannot access path "${docsPath}": ${error}\n` +
              `💡 Make sure the folder exists or specify a different path:\n` +
              `   /testbench enable --input_folder /path/to/your/docs\n` +
              `   /testbench enable https://example.com/llms.txt`;
  }

  return { type: 'message', messageType: 'info', content: message };
}

async function handleDownload(context: CommandContext, args: string[]): Promise<MessageActionReturn> {
  const config = testBenchAnalytics.getConfig();
  
  // Debug info
  console.log('DEBUG: handleDownload called');
  console.log('DEBUG: config =', config);
  console.log('DEBUG: analytics enabled =', testBenchAnalytics.isAnalyticsEnabled());
  
  if (!config || config.mode !== 'url') {
    return { 
      type: 'message', 
      messageType: 'error', 
      content: '❌ Error: Download command only works in URL mode.\nUse: /testbench enable https://example.com/llms.txt' 
    };
  }
  
  if (!testBenchAnalytics.isAnalyticsEnabled()) {
    return { 
      type: 'message', 
      messageType: 'error', 
      content: '❌ Error: Test-bench analytics not enabled.\nUse: /testbench enable first' 
    };
  }
  
  const downloadPath = config.downloadPath || path.join(process.cwd(), 'downloaded-docs');
  
  // Return immediate status while processing in background
  const initialMessage = `🚀 Starting download from: ${config.source}\n` +
                        `📁 Download path: ${downloadPath}\n\n` +
                        `⏳ Processing llms.txt file and downloading content...\n` +
                        `This may take a few moments depending on the number of URLs.`;
  
  // Start the download process asynchronously
  setTimeout(async () => {
    try {
      console.log('DEBUG: Starting download process');
      const downloader = new UrlContentDownloader(downloadPath);
      const result = await downloader.downloadFromLlmsTxt(config.source);
      
      let message = `📥 Download Complete!\n`;
      message += `✅ Successfully downloaded: ${result.downloadedCount}/${result.totalUrls} files\n`;
      message += `📁 Content saved to: ${downloadPath}\n`;
      
      if (result.failed.length > 0) {
        message += `\n❌ Failed downloads (${result.failed.length}):\n`;
        result.failed.slice(0, 3).forEach((failure: { url: string; error: string }) => {
          message += `  • ${failure.url}: ${failure.error.substring(0, 100)}\n`;
        });
        if (result.failed.length > 3) {
          message += `  ... and ${result.failed.length - 3} more failures\n`;
        }
      }
      
      if (result.successful.length > 0) {
        message += `\n📄 Downloaded content:\n`;
        result.successful.slice(0, 5).forEach((content: { title?: string; url: string }) => {
          message += `  • ${content.title || 'Untitled'}\n`;
        });
        if (result.successful.length > 5) {
          message += `  ... and ${result.successful.length - 5} more files\n`;
        }
      }
      
      message += `\n🎉 Ready for analysis! Ask questions about the downloaded content.`;
      
      // Add completion message to UI
      context.ui.addItem({
        type: 'info',
        text: message
      }, Date.now());
      
    } catch (error) {
      console.error('DEBUG: Download error:', error);
      context.ui.addItem({
        type: 'error',
        text: `❌ Download failed: ${error}`
      }, Date.now());
    }
  }, 100); // Small delay to ensure initial message shows first
  
  return { type: 'message', messageType: 'info', content: initialMessage };
}

async function handleTest(context: CommandContext, args: string[]): Promise<MessageActionReturn> {
  // Simple test to verify URL downloading works
  const testUrl = args[0];
  
  if (!testUrl) {
    return {
      type: 'message',
      messageType: 'error',
      content: '❌ Please provide a test URL.\nUsage: /testbench test https://example.com/llms.txt'
    };
  }
  
  try {
    const testPath = path.join(process.cwd(), 'test-download');
    const downloader = new UrlContentDownloader(testPath);
    
    // Test basic fetch first
    const response = await fetch(testUrl);
    if (!response.ok) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ Failed to fetch URL: ${response.status} ${response.statusText}`
      };
    }
    
    const content = await response.text();
    let message = `✅ URL fetch test successful!\n`;
    message += `📊 Response size: ${content.length} characters\n`;
    message += `📄 Content preview (first 200 chars):\n`;
    message += `${content.substring(0, 200)}${content.length > 200 ? '...' : ''}\n\n`;
    
    // If it looks like llms.txt, try parsing it
    if (testUrl.includes('llms.txt') || content.includes('http')) {
      const lines = content.split('\n').filter(line => 
        line.trim() && 
        !line.trim().startsWith('#') && 
        !line.trim().startsWith('//')
      );
      
      const urls = lines.filter(line => 
        line.trim().startsWith('http://') || 
        line.trim().startsWith('https://')
      );
      
      message += `🔗 Detected ${urls.length} URLs in the content:\n`;
      urls.slice(0, 5).forEach(url => {
        message += `  • ${url.trim()}\n`;
      });
      if (urls.length > 5) {
        message += `  ... and ${urls.length - 5} more URLs\n`;
      }
    }
    
    return {
      type: 'message',
      messageType: 'info',
      content: message
    };
    
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `❌ Test failed: ${error}`
    };
  }
}

async function handleDisable(context: CommandContext): Promise<MessageActionReturn> {
  testBenchAnalytics.enableAnalytics(false);
  return { type: 'message', messageType: 'info', content: '⏹️  Test-bench analytics disabled.' };
}

async function handleStatus(context: CommandContext): Promise<MessageActionReturn> {
  const isEnabled = testBenchAnalytics.isAnalyticsEnabled();
  const history = testBenchAnalytics.getSearchHistory();
  const config = testBenchAnalytics.getConfig();
  
  let message = '📊 TEST-BENCH STATUS\n==================\n';
  message += `Status: ${isEnabled ? '✅ ENABLED' : '❌ DISABLED'}\n`;
  
  if (isEnabled && config) {
    message += `Mode: ${config.mode.toUpperCase()}\n`;
    
    if (config.mode === 'url') {
      message += `Source URL: ${config.source}\n`;
      message += `Download path: ${config.downloadPath || 'Not set'}\n`;
      
      // Check if content has been downloaded
      if (config.downloadPath) {
        try {
          const files = await fs.readdir(config.downloadPath);
          const txtFiles = files.filter(f => f.endsWith('.txt'));
          message += `Downloaded files: ${txtFiles.length}\n`;
        } catch {
          message += `Downloaded files: 0 (folder not found)\n`;
        }
      }
    } else {
      message += `Document folder: ${config.source}\n`;
    }
    
    message += `Searches tracked: ${history.length}\n`;
    
    if (history.length > 0) {
      const lastSearch = history[history.length - 1];
      const timeAgo = new Date(Date.now() - lastSearch.timestamp);
      message += `Last search: ${timeAgo.getMinutes()}m ${timeAgo.getSeconds()}s ago\n`;
      message += `Last query: "${lastSearch.query}"`;
    }
  } else {
    message += '\nUsage:\n';
    message += '  /testbench enable --input_folder /path/to/docs  # Folder mode\n';
    message += '  /testbench enable https://example.com/llms.txt  # URL mode';
  }
  
  return { type: 'message', messageType: 'info', content: message };
}

async function handleSetPath(context: CommandContext, args: string[]): Promise<MessageActionReturn> {
  if (args.length === 0) {
    return { 
      type: 'message', 
      messageType: 'error',
      content: '❌ Error: Please specify a path.\nUsage: /testbench setpath /path/to/docs' 
    };
  }

  const docsPath = args[0];
  
  try {
    const stats = await fs.stat(docsPath);
    if (!stats.isDirectory()) {
      return { type: 'message', messageType: 'error', content: '❌ Error: Specified path is not a directory.' };
    }

    testBenchAnalytics.setTestDocsPath(docsPath);
    return { type: 'message', messageType: 'info', content: `✅ Document folder updated: ${docsPath}` };
    
  } catch (error) {
    return { type: 'message', messageType: 'error', content: `❌ Error: Cannot access path "${docsPath}": ${error}` };
  }
}

async function handleReport(context: CommandContext): Promise<MessageActionReturn> {
  const report = testBenchAnalytics.generateReport();
  return { type: 'message', messageType: 'info', content: report };
}

async function handleExport(context: CommandContext, args: string[]): Promise<MessageActionReturn> {
  const exportPath = args[0];
  
  try {
    const filePath = await testBenchAnalytics.exportAnalytics(exportPath);
    return { type: 'message', messageType: 'info', content: `✅ Analytics data exported to: ${filePath}` };
  } catch (error) {
    return { type: 'message', messageType: 'error', content: `❌ Error exporting analytics: ${error}` };
  }
}

async function handleClear(context: CommandContext): Promise<MessageActionReturn> {
  // Clear search history by creating a new instance
  testBenchAnalytics['searchHistory'] = [];
  return { type: 'message', messageType: 'info', content: '✅ Search history cleared.' };
}

async function handleHelp(context: CommandContext): Promise<MessageActionReturn> {
  const message = 
    '🧪 TEST-BENCH COMMANDS\n' +
    '====================\n\n' +
    'SETUP COMMANDS:\n' +
    '/testbench enable --input_folder <path>     - Enable analytics for local folder\n' +
    '/testbench enable <llms.txt-url>            - Enable analytics for URL content\n' +
    '/testbench download                         - Download content from llms.txt (URL mode only)\n' +
    '/testbench disable                          - Disable analytics\n\n' +
    'ANALYSIS COMMANDS:\n' +
    '/testbench status                           - Show current status and config\n' +
    '/testbench report                           - Generate analytics report\n' +
    '/testbench export [file]                    - Export analytics to JSON\n' +
    '/testbench clear                            - Clear search history\n\n' +
    'EXAMPLE WORKFLOWS:\n\n' +
    '📁 Folder Mode:\n' +
    '1. /testbench enable --input_folder ./my-docs\n' +
    '2. Ask questions about your documents\n' +
    '3. /testbench report\n\n' +
    '🌐 URL Mode:\n' +
    '1. /testbench enable https://example.com/llms.txt\n' +
    '2. /testbench download\n' +
    '3. Ask questions about the downloaded content\n' +
    '4. /testbench report\n\n' +
    'The test-bench will track all search operations with detailed analytics\n' +
    'including search patterns, results, embeddings, and ranking factors.';

  return { type: 'message', messageType: 'info', content: message };
}

export const testBenchCommand: SlashCommand = {
  name: 'testbench',
  description: 'Configure test-bench mode for document indexing analysis',
  kind: CommandKind.BUILT_IN,
  action: handleTestBenchCommand,
};