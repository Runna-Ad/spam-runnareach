-- Migration 0019: add claude_search (AI Search) to discovery_source enum
alter type discovery_source add value if not exists 'claude_search';
