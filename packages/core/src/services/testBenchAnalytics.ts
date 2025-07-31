/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

export interface SearchAnalytics {
  timestamp: number;
  query: string;
  searchType: 'grep' | 'embedding' | 'glob' | 'read_files';
  targetPath: string;
  pattern?: string;
  executionTimeMs: number;
  resultsFound: number;
  filesScanned: number;
  matchDetails: MatchAnalytics[];
  embeddingDetails?: EmbeddingAnalytics;
  searchStrategy: string;
  rankingFactors?: RankingFactor[];
  toolDecisionReason?: string;
  searchParameters?: Record<string, any>;
}

export interface MatchAnalytics {
  filePath: string;
  lineNumber?: number;
  matchText: string;
  contextBefore?: string;
  contextAfter?: string;
  relevanceScore?: number;
  matchReason: string;
  fileSize: number;
  fileLastModified: number;
}

export interface EmbeddingAnalytics {
  queryEmbedding: number[];
  documentEmbeddings: Array<{
    filePath: string;
    embedding: number[];
    similarityScore: number;
    chunkIndex?: number;
    chunkText?: string;
    contentPreview?: string;
    tokenCount?: number;
  }>;
  embeddingModel: string;
  embeddingTimeMs: number;
  totalTokensProcessed?: number;
  averageSimilarity?: number;
}

export interface RankingFactor {
  factor: string;
  weight: number;
  value: number;
  impact: number;
  explanation: string;
}

export type TestBenchMode = 'folder' | 'url';

export interface TestBenchConfig {
  mode: TestBenchMode;
  source: string; // folder path or URL
  downloadPath?: string; // where downloaded content is stored
}

export class TestBenchAnalytics {
  private searchHistory: SearchAnalytics[] = [];
  private testDocsPath: string;
  private analyticsEnabled: boolean = false;
  private config: TestBenchConfig | null = null;

  constructor(testDocsPath?: string) {
    this.testDocsPath = testDocsPath || path.join(process.cwd(), 'input-docs');
  }

  setTestDocsPath(path: string) {
    this.testDocsPath = path;
  }

  setConfig(config: TestBenchConfig) {
    this.config = config;
    if (config.mode === 'url' && config.downloadPath) {
      this.testDocsPath = config.downloadPath;
    } else if (config.mode === 'folder') {
      this.testDocsPath = config.source;
    }
  }

  getConfig(): TestBenchConfig | null {
    return this.config;
  }

  enableAnalytics(enabled: boolean = true) {
    this.analyticsEnabled = enabled;
    if (enabled) {
      const mode = this.config?.mode || 'folder';
      const source = this.config?.source || this.testDocsPath;
      console.log(`🔍 Test-bench analytics enabled`);
      console.log(`   Mode: ${mode}`);
      console.log(`   Source: ${source}`);
      console.log(`   Analysis path: ${this.testDocsPath}`);
    }
  }

  isAnalyticsEnabled(): boolean {
    return this.analyticsEnabled;
  }

  startSearch(query: string, searchType: SearchAnalytics['searchType'], targetPath: string): SearchSession {
    if (!this.analyticsEnabled) {
      return new SearchSession(null);
    }

    const analytics: SearchAnalytics = {
      timestamp: Date.now(),
      query,
      searchType,
      targetPath,
      executionTimeMs: 0,
      resultsFound: 0,
      filesScanned: 0,
      matchDetails: [],
      searchStrategy: this.determineSearchStrategy(query, searchType),
    };

    return new SearchSession(analytics, (completedAnalytics) => {
      this.searchHistory.push(completedAnalytics);
      this.logSearchResults(completedAnalytics);
    });
  }

  private determineSearchStrategy(query: string, searchType: string): string {
    const strategies = [];
    
    if (query.includes('*') || query.includes('?')) {
      strategies.push('glob-pattern');
    }
    
    if (/[.*+?^${}()|[\]\\]/.test(query)) {
      strategies.push('regex-search');
    }
    
    if (query.split(' ').length > 1) {
      strategies.push('multi-term');
    }
    
    if (searchType === 'embedding') {
      strategies.push('semantic-similarity');
    }
    
    strategies.push(`tool-${searchType}`);
    
    return strategies.join('+');
  }

  private logSearchResults(analytics: SearchAnalytics) {
    console.log('\n📊 SEARCH ANALYTICS REPORT');
    console.log('=' .repeat(50));
    console.log(`Query: "${analytics.query}"`);
    console.log(`Type: ${analytics.searchType}`);
    console.log(`Strategy: ${analytics.searchStrategy}`);
    console.log(`Execution Time: ${analytics.executionTimeMs.toFixed(2)}ms`);
    console.log(`Files Scanned: ${analytics.filesScanned}`);
    console.log(`Results Found: ${analytics.resultsFound}`);
    
    if (analytics.embeddingDetails) {
      console.log(`\n🧠 EMBEDDING ANALYSIS:`);
      console.log(`Model: ${analytics.embeddingDetails.embeddingModel}`);
      console.log(`Embedding Time: ${analytics.embeddingDetails.embeddingTimeMs.toFixed(2)}ms`);
      console.log(`Top Similarities:`);
      
      analytics.embeddingDetails.documentEmbeddings
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, 5)
        .forEach((doc, i) => {
          console.log(`  ${i + 1}. ${path.basename(doc.filePath)} (${(doc.similarityScore * 100).toFixed(1)}%)`);
        });
    }

    if (analytics.matchDetails.length > 0) {
      console.log(`\n🎯 TOP MATCHES:`);
      analytics.matchDetails
        .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
        .slice(0, 3)
        .forEach((match, i) => {
          console.log(`  ${i + 1}. ${path.basename(match.filePath)}:${match.lineNumber || 'N/A'}`);
          console.log(`     Reason: ${match.matchReason}`);
          if (match.relevanceScore) {
            console.log(`     Score: ${(match.relevanceScore * 100).toFixed(1)}%`);
          }
          console.log(`     Match: "${match.matchText.substring(0, 100)}${match.matchText.length > 100 ? '...' : ''}"`);
        });
    }

    if (analytics.rankingFactors && analytics.rankingFactors.length > 0) {
      console.log(`\n⚖️  RANKING FACTORS:`);
      analytics.rankingFactors.forEach((factor) => {
        console.log(`  • ${factor.factor}: ${factor.value} (weight: ${factor.weight}, impact: ${factor.impact.toFixed(2)})`);
        console.log(`    ${factor.explanation}`);
      });
    }

    console.log('=' .repeat(50));
  }

  getSearchHistory(): SearchAnalytics[] {
    return [...this.searchHistory];
  }

  generateReport(): string {
    if (this.searchHistory.length === 0) {
      return 'No search analytics data available.';
    }

    let report = '\n🔍 DETAILED TEST-BENCH ANALYTICS REPORT\n';
    report += '='.repeat(80) + '\n\n';
    
    const totalSearches = this.searchHistory.length;
    const avgExecutionTime = this.searchHistory.reduce((sum, s) => sum + s.executionTimeMs, 0) / totalSearches;
    const totalResults = this.searchHistory.reduce((sum, s) => sum + s.resultsFound, 0);
    
    // Executive Summary
    report += '📊 EXECUTIVE SUMMARY\n';
    report += '-'.repeat(40) + '\n';
    report += `Total Search Operations: ${totalSearches}\n`;
    report += `Total Files Processed: ${this.getTotalFilesProcessed()}\n`;
    report += `Average Execution Time: ${avgExecutionTime.toFixed(2)}ms\n`;
    report += `Total Results Found: ${totalResults}\n`;
    report += `Success Rate: ${this.getSuccessRate()}%\n\n`;

    // Detailed Search Breakdown
    report += '🔎 DETAILED SEARCH OPERATIONS\n';
    report += '-'.repeat(40) + '\n';
    
    this.searchHistory.forEach((search, index) => {
      report += `\n[${index + 1}] SEARCH OPERATION\n`;
      report += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      report += `🕒 Timestamp: ${new Date(search.timestamp).toLocaleString()}\n`;
      report += `📝 Query: "${search.query}"\n`;
      report += `🔧 Tool Used: ${search.searchType.toUpperCase()}\n`;
      report += `⚡ Strategy: ${search.searchStrategy}\n`;
      report += `⏱️  Execution Time: ${search.executionTimeMs.toFixed(2)}ms\n`;
      report += `📁 Files Scanned: ${search.filesScanned || 'N/A'}\n`;
      report += `✅ Results Found: ${search.resultsFound}\n`;
      
      if (search.pattern) {
        report += `🔍 Search Pattern: "${search.pattern}"\n`;
      }
      
      if (search.toolDecisionReason) {
        report += `🎯 Tool Selection: ${search.toolDecisionReason}\n`;
      }
      
      if (search.searchParameters) {
        report += `⚙️  Parameters: ${JSON.stringify(search.searchParameters, null, 2).replace(/\n/g, '\n     ')}\n`;
      }
      
      // File matches details
      if (search.matchDetails && search.matchDetails.length > 0) {
        report += `\n📋 MATCHED FILES:\n`;
        search.matchDetails.forEach((match, matchIndex) => {
          report += `  ${matchIndex + 1}. 📄 ${match.filePath}`;
          if (match.lineNumber && match.lineNumber > 0) {
            report += ` (line ${match.lineNumber})`;
          }
          report += `\n`;
          report += `     📏 File Size: ${this.formatBytes(match.fileSize)}\n`;
          report += `     📅 Modified: ${new Date(match.fileLastModified).toLocaleString()}\n`;
          if (match.relevanceScore) {
            report += `     ⭐ Relevance: ${(match.relevanceScore * 100).toFixed(1)}%\n`;
          }
          report += `     💡 Reason: ${match.matchReason}\n`;
          if (match.matchText && match.matchText.length > 0) {
            const preview = match.matchText.length > 100 
              ? match.matchText.substring(0, 100) + '...' 
              : match.matchText;
            report += `     📖 Preview: "${preview}"\n`;
          }
          if (match.contextBefore || match.contextAfter) {
            report += `     🔍 Context: ${match.contextBefore || ''}${match.contextAfter || ''}\n`;
          }
          report += `\n`;
        });
      }
      
      // Embedding details
      if (search.embeddingDetails) {
        report += `🧠 EMBEDDING ANALYSIS:\n`;
        report += `  🤖 Model: ${search.embeddingDetails.embeddingModel}\n`;
        report += `  ⏱️  Generation Time: ${search.embeddingDetails.embeddingTimeMs.toFixed(2)}ms\n`;
        report += `  📊 Query Embedding Dimensions: ${search.embeddingDetails.queryEmbedding.length}\n`;
        report += `  📚 Documents Analyzed: ${search.embeddingDetails.documentEmbeddings.length}\n`;
        
        if (search.embeddingDetails.documentEmbeddings.length > 0) {
          report += `\n  🎯 TOP SEMANTIC MATCHES:\n`;
          const sortedEmbeddings = search.embeddingDetails.documentEmbeddings
            .sort((a, b) => b.similarityScore - a.similarityScore)
            .slice(0, 5);
          
          sortedEmbeddings.forEach((doc, docIndex) => {
            report += `    ${docIndex + 1}. ${path.basename(doc.filePath)} - ${(doc.similarityScore * 100).toFixed(1)}% similarity\n`;
            if (doc.contentPreview || doc.chunkText) {
              const content = doc.contentPreview || doc.chunkText || '';
              const preview = content.length > 80 
                ? content.substring(0, 80) + '...' 
                : content;
              report += `       📝 "${preview}"\n`;
            }
          });
        }
        report += `\n`;
      }
      
      // Ranking factors
      if (search.rankingFactors && search.rankingFactors.length > 0) {
        report += `⚖️  RANKING FACTORS:\n`;
        search.rankingFactors.forEach((factor) => {
          report += `  • ${factor.factor}: ${factor.value} (weight: ${factor.weight}, impact: ${factor.impact.toFixed(2)})\n`;
          report += `    📝 ${factor.explanation}\n`;
        });
        report += `\n`;
      }
    });

    // Performance Analysis
    report += '\n📈 PERFORMANCE ANALYSIS\n';
    report += '-'.repeat(40) + '\n';
    
    const typeBreakdown = this.getToolUsageBreakdown();
    report += `🔧 TOOL USAGE BREAKDOWN:\n`;
    Object.entries(typeBreakdown).forEach(([type, stats]) => {
      report += `  ${type.toUpperCase()}: ${stats.count} uses (${stats.percentage}%), avg ${stats.avgTime}ms, ${stats.avgResults} results\n`;
    });
    
    const strategyBreakdown = this.getStrategyBreakdown();
    report += `\n🎯 STRATEGY EFFECTIVENESS:\n`;
    Object.entries(strategyBreakdown).forEach(([strategy, stats]) => {
      report += `  ${strategy}: ${stats.avgResults} avg results, ${stats.avgTime}ms avg time, ${stats.count} uses\n`;
    });
    
    // File Access Patterns
    const filePatterns = this.getFileAccessPatterns();
    if (filePatterns.length > 0) {
      report += `\n📁 FILE ACCESS PATTERNS:\n`;
      filePatterns.slice(0, 10).forEach((pattern, index) => {
        report += `  ${index + 1}. ${pattern.file} - accessed ${pattern.count} times\n`;
      });
    }

    report += '\n' + '='.repeat(80) + '\n';
    report += `📊 Generated: ${new Date().toLocaleString()}\n`;
    
    return report;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  private getTotalFilesProcessed(): number {
    return this.searchHistory.reduce((sum, s) => sum + (s.filesScanned || 0), 0);
  }

  private getSuccessRate(): number {
    const successfulSearches = this.searchHistory.filter(s => s.resultsFound > 0).length;
    return ((successfulSearches / this.searchHistory.length) * 100).toFixed(1) as any;
  }

  private getToolUsageBreakdown(): Record<string, { count: number; percentage: string; avgTime: string; avgResults: string }> {
    const breakdown = this.searchHistory.reduce((acc, s) => {
      if (!acc[s.searchType]) {
        acc[s.searchType] = { count: 0, totalTime: 0, totalResults: 0 };
      }
      acc[s.searchType].count++;
      acc[s.searchType].totalTime += s.executionTimeMs;
      acc[s.searchType].totalResults += s.resultsFound;
      return acc;
    }, {} as Record<string, { count: number; totalTime: number; totalResults: number }>);

    const total = this.searchHistory.length;
    return Object.entries(breakdown).reduce((acc, [type, stats]) => {
      acc[type] = {
        count: stats.count,
        percentage: ((stats.count / total) * 100).toFixed(1) + '%',
        avgTime: (stats.totalTime / stats.count).toFixed(2),
        avgResults: (stats.totalResults / stats.count).toFixed(1)
      };
      return acc;
    }, {} as any);
  }

  private getStrategyBreakdown(): Record<string, { avgResults: string; avgTime: string; count: number }> {
    const breakdown = this.searchHistory.reduce((acc, s) => {
      if (!acc[s.searchStrategy]) {
        acc[s.searchStrategy] = { count: 0, totalTime: 0, totalResults: 0 };
      }
      acc[s.searchStrategy].count++;
      acc[s.searchStrategy].totalTime += s.executionTimeMs;
      acc[s.searchStrategy].totalResults += s.resultsFound;
      return acc;
    }, {} as Record<string, { count: number; totalTime: number; totalResults: number }>);

    return Object.entries(breakdown).reduce((acc, [strategy, stats]) => {
      acc[strategy] = {
        avgResults: (stats.totalResults / stats.count).toFixed(1),
        avgTime: (stats.totalTime / stats.count).toFixed(2),
        count: stats.count
      };
      return acc;
    }, {} as any);
  }

  private getFileAccessPatterns(): Array<{ file: string; count: number }> {
    const fileAccess = this.searchHistory.reduce((acc, search) => {
      search.matchDetails?.forEach(match => {
        const fileName = path.basename(match.filePath);
        acc[fileName] = (acc[fileName] || 0) + 1;
      });
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(fileAccess)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count);
  }

  async exportAnalytics(filePath?: string): Promise<string> {
    const exportPath = filePath || path.join(this.testDocsPath, '..', 'analytics-export.json');
    const data = {
      exportedAt: new Date().toISOString(),
      testDocsPath: this.testDocsPath,
      searchHistory: this.searchHistory,
      summary: {
        totalSearches: this.searchHistory.length,
        avgExecutionTime: this.searchHistory.reduce((sum, s) => sum + s.executionTimeMs, 0) / this.searchHistory.length,
        totalResults: this.searchHistory.reduce((sum, s) => sum + s.resultsFound, 0),
      }
    };

    await fs.writeFile(exportPath, JSON.stringify(data, null, 2));
    return exportPath;
  }
}

export class SearchSession {
  private analytics: SearchAnalytics | null;
  private startTime: number;
  private onComplete?: (analytics: SearchAnalytics) => void;

  constructor(analytics: SearchAnalytics | null, onComplete?: (analytics: SearchAnalytics) => void) {
    this.analytics = analytics;
    this.startTime = performance.now();
    this.onComplete = onComplete;
  }

  addMatch(match: MatchAnalytics) {
    if (this.analytics) {
      this.analytics.matchDetails.push(match);
      this.analytics.resultsFound++;
    }
  }

  setFilesScanned(count: number) {
    if (this.analytics) {
      this.analytics.filesScanned = count;
    }
  }

  setPattern(pattern: string) {
    if (this.analytics) {
      this.analytics.pattern = pattern;
    }
  }

  setEmbeddingDetails(details: EmbeddingAnalytics) {
    if (this.analytics) {
      this.analytics.embeddingDetails = details;
    }
  }

  addRankingFactor(factor: RankingFactor) {
    if (this.analytics) {
      this.analytics.rankingFactors = this.analytics.rankingFactors || [];
      this.analytics.rankingFactors.push(factor);
    }
  }

  complete(): SearchAnalytics | null {
    if (this.analytics) {
      this.analytics.executionTimeMs = performance.now() - this.startTime;
      this.onComplete?.(this.analytics);
    }
    return this.analytics;
  }

  isActive(): boolean {
    return this.analytics !== null;
  }

  getAnalytics(): SearchAnalytics | null {
    return this.analytics;
  }

  setToolDecisionReason(reason: string) {
    if (this.analytics) {
      this.analytics.toolDecisionReason = reason;
    }
  }

  setSearchParameters(params: Record<string, any>) {
    if (this.analytics) {
      this.analytics.searchParameters = params;
    }
  }
}

// Global instance
export const testBenchAnalytics = new TestBenchAnalytics();