/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';

export interface DownloadedContent {
  url: string;
  content: string;
  title?: string;
  contentType: string;
  downloadedAt: number;
  filePath: string;
}

export interface DownloadResult {
  successful: DownloadedContent[];
  failed: Array<{ url: string; error: string }>;
  totalUrls: number;
  downloadedCount: number;
}

export class UrlContentDownloader {
  private outputDir: string;
  private maxConcurrentDownloads: number = 50;
  private downloadDelay: number = 500; // 0.5 seconds between batches

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  /**
   * Download content from a URL that contains an llms.txt file
   */
  async downloadFromLlmsTxt(llmsTxtUrl: string): Promise<DownloadResult> {
    console.log(`📥 Fetching llms.txt from: ${llmsTxtUrl}`);
    
    try {
      // Fetch the llms.txt content
      const response = await fetch(llmsTxtUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch llms.txt: ${response.status} ${response.statusText}`);
      }
      
      const llmsTxtContent = await response.text();
      console.log(`📄 Parsed llms.txt content (${llmsTxtContent.length} characters)`);
      
      // Parse URLs from llms.txt
      const urls = this.parseLlmsTxt(llmsTxtContent, llmsTxtUrl);
      console.log(`🔗 Found ${urls.length} URLs to download`);
      
      // Download all URLs
      return await this.downloadUrls(urls);
      
    } catch (error) {
      console.error(`❌ Error processing llms.txt from ${llmsTxtUrl}:`, error);
      return {
        successful: [],
        failed: [{ url: llmsTxtUrl, error: `Failed to fetch llms.txt: ${error}` }],
        totalUrls: 1,
        downloadedCount: 0
      };
    }
  }

  /**
   * Parse URLs from llms.txt content
   */
  private parseLlmsTxt(content: string, baseUrl: string): string[] {
    const urls: string[] = [];
    const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
    
    for (const line of lines) {
      // Skip comments
      if (line.startsWith('#') || line.startsWith('//')) {
        continue;
      }
      
      try {
        // Handle relative URLs
        let url: string;
        if (line.startsWith('http://') || line.startsWith('https://')) {
          url = line;
        } else {
          // Convert relative URL to absolute
          const baseUrlObj = new URL(baseUrl);
          url = new URL(line, baseUrlObj.origin).toString();
        }
        
        urls.push(url);
        console.log(`  📌 Found URL: ${url}`);
      } catch (error) {
        console.warn(`⚠️  Skipping invalid URL: ${line} (${error})`);
      }
    }
    
    return urls;
  }

  /**
   * Download content from multiple URLs with concurrency control
   */
  async downloadUrls(urls: string[]): Promise<DownloadResult> {
    const result: DownloadResult = {
      successful: [],
      failed: [],
      totalUrls: urls.length,
      downloadedCount: 0
    };

    // Ensure output directory exists
    await fs.mkdir(this.outputDir, { recursive: true });
    
    console.log(`🚀 Starting downloads to: ${this.outputDir}`);
    
    // Process URLs in batches for concurrency control
    const batches = this.chunkArray(urls, this.maxConcurrentDownloads);
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`📦 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} URLs)`);
      
      const batchPromises = batch.map(url => this.downloadSingleUrl(url));
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((batchResult, index) => {
        if (batchResult.status === 'fulfilled') {
          result.successful.push(batchResult.value);
          result.downloadedCount++;
          console.log(`✅ Downloaded: ${batch[index]}`);
        } else {
          result.failed.push({
            url: batch[index],
            error: batchResult.reason?.message || 'Unknown error'
          });
          console.error(`❌ Failed: ${batch[index]} - ${batchResult.reason?.message}`);
        }
      });
      
      // Add delay between batches to be respectful
      if (batchIndex < batches.length - 1) {
        console.log(`⏳ Waiting ${this.downloadDelay}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, this.downloadDelay));
      }
    }
    
    console.log(`🎉 Download complete: ${result.downloadedCount}/${result.totalUrls} successful`);
    return result;
  }

  /**
   * Download content from a single URL
   */
  private async downloadSingleUrl(url: string): Promise<DownloadedContent> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Gemini-CLI-TestBench/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const content = await response.text();
    const contentType = response.headers.get('content-type') || 'text/plain';
    
    // Extract title from HTML if possible
    let title = this.extractTitle(content, contentType);
    if (!title) {
      title = this.urlToFilename(url);
    }
    
    // Create safe filename
    const filename = this.sanitizeFilename(title) + '.txt';
    const filePath = path.join(this.outputDir, filename);
    
    // Save content to file
    const fileContent = this.formatContent(url, content, contentType, title);
    await fs.writeFile(filePath, fileContent, 'utf8');
    
    return {
      url,
      content: fileContent,
      title,
      contentType,
      downloadedAt: Date.now(),
      filePath
    };
  }

  /**
   * Extract title from HTML content
   */
  private extractTitle(content: string, contentType: string): string | null {
    if (!contentType.includes('html')) {
      return null;
    }
    
    const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : null;
  }

  /**
   * Generate filename from URL
   */
  private urlToFilename(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      if (pathname && pathname !== '/') {
        const segments = pathname.split('/').filter(Boolean);
        return segments[segments.length - 1] || urlObj.hostname;
      }
      
      return urlObj.hostname;
    } catch {
      return 'downloaded-content';
    }
  }

  /**
   * Sanitize filename for filesystem
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 100); // Limit length
  }

  /**
   * Format downloaded content with metadata
   */
  private formatContent(url: string, content: string, contentType: string, title?: string): string {
    const metadata = [
      '# Downloaded Content',
      `URL: ${url}`,
      `Title: ${title || 'N/A'}`,
      `Content-Type: ${contentType}`,
      `Downloaded: ${new Date().toISOString()}`,
      '',
      '---',
      '',
      content
    ].join('\n');
    
    return metadata;
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Get download statistics
   */
  async getDownloadStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    oldestFile: Date | null;
    newestFile: Date | null;
  }> {
    try {
      const files = await fs.readdir(this.outputDir);
      const txtFiles = files.filter(f => f.endsWith('.txt'));
      
      let totalSize = 0;
      let oldestTime = Infinity;
      let newestTime = 0;
      
      for (const file of txtFiles) {
        const filePath = path.join(this.outputDir, file);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
        oldestTime = Math.min(oldestTime, stats.mtime.getTime());
        newestTime = Math.max(newestTime, stats.mtime.getTime());
      }
      
      return {
        totalFiles: txtFiles.length,
        totalSize,
        oldestFile: oldestTime === Infinity ? null : new Date(oldestTime),
        newestFile: newestTime === 0 ? null : new Date(newestTime)
      };
    } catch {
      return {
        totalFiles: 0,
        totalSize: 0,
        oldestFile: null,
        newestFile: null
      };
    }
  }
}