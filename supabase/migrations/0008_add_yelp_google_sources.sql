-- Migration 0008: add yelp + google_places to discovery_source enum
alter type discovery_source add value if not exists 'yelp';
alter type discovery_source add value if not exists 'google_places';
alter type discovery_source add value if not exists 'denue';
