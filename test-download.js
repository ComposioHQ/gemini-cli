#!/usr/bin/env node

/**
 * Standalone script to test document downloading from llms.txt URLs
 * Usage: node test-download.js <llms.txt-url>
 */

import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';

class SimpleDownloader {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.maxConcurrentDownloads = 50;
    this.downloadDelay = 500; // 0.5 seconds between batches
  }

  async downloadFromLlmsTxt(llmsTxtUrl) {
    console.log(`📥 Fetching llms.txt from: ${llmsTxtUrl}`);
    
    try {
      // Fetch the llms.txt content
      const response = await fetch(llmsTxtUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch llms.txt: ${response.status} ${response.statusText}`);
      }
      
      const llmsTxtContent = await response.text();
      console.log(`📄 Downloaded llms.txt (${llmsTxtContent.length} characters)`);
      console.log(`📄 Content preview:\n${llmsTxtContent.substring(0, 300)}...\n`);
      
      // Parse URLs from llms.txt
      const urls = this.parseLlmsTxt(llmsTxtContent, llmsTxtUrl);
      console.log(`🔗 Found ${urls.length} URLs to download`);
      
      if (urls.length === 0) {
        console.log('❌ No valid URLs found in llms.txt');
        return;
      }
      
      // Show first few URLs
      console.log('📋 URLs to download:');
      urls.slice(0, 5).forEach((url, i) => {
        console.log(`  ${i + 1}. ${url}`);
      });
      if (urls.length > 5) {
        console.log(`  ... and ${urls.length - 5} more`);
      }
      
      // Download all URLs
      return await this.downloadUrls(urls);
      
    } catch (error) {
      console.error(`❌ Error processing llms.txt: ${error.message}`);
      throw error;
    }
  }

  parseLlmsTxt(content, baseUrl) {
    console.log(`📋 Parsing llms.txt file (${content.length} characters)`);
    
    try {
      const parsed = this.parseStructuredLlmsTxt(content);
      console.log(`📖 Found document: "${parsed.title}"`);
      if (parsed.summary) {
        console.log(`📝 Summary: ${parsed.summary}`);
      }
      
      const allLinks = [];
      
      // Extract links from all sections
      for (const [sectionName, links] of Object.entries(parsed.sections)) {
        console.log(`\n📂 Section: ${sectionName} (${links.length} links)`);
        
        for (const link of links) {
          try {
            // Resolve relative URLs if needed
            let resolvedUrl = link.url;
            if (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://')) {
              const baseUrlObj = new URL(baseUrl);
              resolvedUrl = new URL(link.url, baseUrlObj.origin).toString();
            }
            
            allLinks.push({
              url: resolvedUrl,
              title: link.title,
              description: link.desc || '',
              section: sectionName
            });
            
            console.log(`  ✅ [${link.title}] ${resolvedUrl}`);
            if (link.desc) {
              console.log(`     📝 ${link.desc}`);
            }
          } catch (error) {
            console.log(`  ❌ Skipping invalid URL in ${sectionName}: ${link.url} (${error.message})`);
          }
        }
      }
      
      console.log(`\n🎯 Total URLs found: ${allLinks.length}`);
      return allLinks;
      
    } catch (error) {
      console.log(`⚠️  Failed to parse structured llms.txt, falling back to simple parsing: ${error.message}`);
      return this.parseSimpleLlmsTxt(content, baseUrl);
    }
  }

  parseStructuredLlmsTxt(content) {
    // Parse according to llms.txt spec
    
    // Split into sections by ## headers
    const parts = content.split(/^##\s*(.+?)$/gm);
    const [header, ...sectionParts] = parts;
    
    // Parse header section
    const headerMatch = header.trim().match(/^#\s*(.+?)$\n+(?:^>\s*(.+?)$)?\n+(.*)/ms);
    if (!headerMatch) {
      throw new Error('Invalid llms.txt format: missing title');
    }
    
    const [, title, summary, info] = headerMatch;
    
    // Parse sections
    const sections = {};
    for (let i = 0; i < sectionParts.length; i += 2) {
      const sectionName = sectionParts[i];
      const sectionContent = sectionParts[i + 1];
      
      if (sectionName && sectionContent) {
        sections[sectionName.trim()] = this.parseLinks(sectionContent);
      }
    }
    
    return {
      title: title.trim(),
      summary: summary?.trim(),
      info: info?.trim(),
      sections
    };
  }

  parseLinks(linksContent) {
    const links = [];
    const linkPattern = /^-\s*\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/gm;
    
    let match;
    while ((match = linkPattern.exec(linksContent)) !== null) {
      const [, title, url, desc] = match;
      links.push({
        title: title.trim(),
        url: url.trim(),
        desc: desc?.trim() || ''
      });
    }
    
    return links;
  }

  parseSimpleLlmsTxt(content, baseUrl) {
    // Fallback simple parser for non-standard formats
    const urls = [];
    const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
    
    console.log(`📋 Using simple parser for ${lines.length} lines`);
    
    for (const line of lines) {
      // Skip comments and headers
      if (line.startsWith('#') || line.startsWith('//') || line.startsWith('>')) {
        continue;
      }
      
      // Look for URLs in the line
      const urlMatch = line.match(/https?:\/\/[^\s)]+/);
      if (urlMatch) {
        urls.push({
          url: urlMatch[0],
          title: line.replace(/[^\[\]]*\[([^\]]+)\].*/, '$1') || this.urlToFilename(urlMatch[0]),
          description: '',
          section: 'default'
        });
        console.log(`  ✅ Found URL: ${urlMatch[0]}`);
      }
    }
    
    return urls;
  }

  async downloadUrls(urls) {
    // Ensure output directory exists
    await fs.mkdir(this.outputDir, { recursive: true });
    console.log(`📁 Output directory: ${this.outputDir}`);
    
    const results = {
      successful: [],
      failed: [],
      totalUrls: urls.length,
      downloadedCount: 0
    };
    
    // Process URLs one by one to maintain proper indexing
    console.log(`\n🚀 Starting downloads (${this.maxConcurrentDownloads} concurrent)...`);
    
    // Process URLs in small batches but maintain global index
    const batches = this.chunkArray(urls.map((linkObj, index) => ({ linkObj, index })), this.maxConcurrentDownloads);
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`\n📦 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} URLs)`);
      
      const batchPromises = batch.map(({linkObj, index}) => this.downloadSingleUrl(linkObj, index));
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, localIndex) => {
        const {linkObj, index} = batch[localIndex];
        if (result.status === 'fulfilled') {
          results.successful.push(result.value);
          results.downloadedCount++;
          console.log(`  ✅ Downloaded: ${result.value.filename}`);
        } else {
          results.failed.push({
            url: linkObj.url,
            error: result.reason?.message || 'Unknown error'
          });
          console.log(`  ❌ Failed [${index + 1}]: ${linkObj.url} - ${result.reason?.message}`);
        }
      });
      
      // Add delay between batches
      if (batchIndex < batches.length - 1) {
        console.log(`  ⏳ Waiting ${this.downloadDelay/1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, this.downloadDelay));
      }
    }
    
    return results;
  }

  async downloadSingleUrl(linkObj, index) {
    const { url, title: linkTitle, description, section } = linkObj;
    console.log(`    🌐 Downloading [${index + 1}]: [${linkTitle}] ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TestBench-Downloader/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const content = await response.text();
    const contentType = response.headers.get('content-type') || 'text/plain';
    
    // Use link title from llms.txt, fallback to extracted title
    let title = linkTitle;
    if (!title || title === this.urlToFilename(url)) {
      const extractedTitle = this.extractTitle(content, contentType);
      if (extractedTitle) {
        title = extractedTitle;
      }
    }
    
    // Create unique filename with index and section
    const sectionPrefix = section !== 'default' ? `${this.sanitizeFilename(section)}_` : '';
    const baseFilename = this.sanitizeFilename(title);
    const filename = `${String(index + 1).padStart(3, '0')}_${sectionPrefix}${baseFilename}.txt`;
    const filePath = path.join(this.outputDir, filename);
    
    // Format content with metadata header
    const fileContent = [
      '# Downloaded Content from llms.txt',
      `URL: ${url}`,
      `Title: ${title}`,
      `Link Title: ${linkTitle}`,
      `Description: ${description || 'N/A'}`,
      `Section: ${section}`,
      `Content-Type: ${contentType}`,
      `Downloaded: ${new Date().toISOString()}`,
      `Size: ${content.length} characters`,
      `File: ${filename}`,
      '',
      '---',
      '',
      content
    ].join('\n');
    
    // Save content to individual file
    await fs.writeFile(filePath, fileContent, 'utf8');
    
    return {
      url,
      title,
      linkTitle,
      description,
      section,
      contentType,
      filePath,
      filename,
      size: content.length
    };
  }

  extractTitle(content, contentType) {
    if (!contentType.includes('html')) {
      return null;
    }
    
    const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : null;
  }

  urlToFilename(url) {
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

  sanitizeFilename(filename) {
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 100);
  }

  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('📖 Usage: node test-download.js <llms.txt-url>');
    console.log('');
    console.log('Examples:');
    console.log('  node test-download.js https://example.com/llms.txt');
    console.log('  node test-download.js https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/llms.txt');
    process.exit(1);
  }
  
  const llmsTxtUrl = args[0];
  const outputDir = path.join(process.cwd(), 'downloaded-docs');
  
  console.log('🧪 TestBench Document Downloader');
  console.log('================================');
  console.log(`📥 Source: ${llmsTxtUrl}`);
  console.log(`📁 Output: ${outputDir}`);
  console.log('');
  
  try {
    const downloader = new SimpleDownloader(outputDir);
    const results = await downloader.downloadFromLlmsTxt(llmsTxtUrl);
    
    console.log('\n🎉 Download Complete!');
    console.log('====================');
    console.log(`✅ Successfully downloaded: ${results.downloadedCount}/${results.totalUrls} files`);
    console.log(`📁 Files saved to: ${outputDir}`);
    
    if (results.failed.length > 0) {
      console.log(`\n❌ Failed downloads (${results.failed.length}):`);
      results.failed.forEach(failure => {
        console.log(`  • ${failure.url}: ${failure.error}`);
      });
    }
    
    if (results.successful.length > 0) {
      console.log(`\n📄 Downloaded files:`);
      
      // Group by section for better organization
      const bySection = {};
      results.successful.forEach(content => {
        const section = content.section || 'default';
        if (!bySection[section]) bySection[section] = [];
        bySection[section].push(content);
      });
      
      for (const [section, contents] of Object.entries(bySection)) {
        console.log(`\n📂 Section: ${section}`);
        contents.forEach(content => {
          console.log(`  • ${content.filename}`);
          console.log(`    📄 [${content.linkTitle}]`);
          if (content.description) {
            console.log(`    📝 ${content.description}`);
          }
          console.log(`    📊 ${content.size.toLocaleString()} characters`);
          console.log(`    🔗 ${content.url}`);
          console.log('');
        });
      }
      
      console.log(`💡 Each URL saved as a separate file in ${outputDir}/`);
      console.log(`💡 Files are numbered and organized by section`);
      console.log(`💡 File format: 001_Section_Title.txt`);
    }
    
  } catch (error) {
    console.error(`\n💥 Fatal error: ${error.message}`);
    process.exit(1);
  }
}

main().catch(console.error);