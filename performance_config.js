// Performance configuration for large-scale map processing
export default {
  // Number of worker threads for parallel processing
  // Set to 0 to use (CPU cores - 1) automatically
  workerThreads: 0,
  
  // Tile size for Overpass queries (degrees)
  // With streaming parser, we can use larger tiles safely
  overpassTileSize: {
    roads: 0.5,
    buildings: 0.4,  // Larger tiles now safe with streaming parser
    places: 0.5,
  },
  
  // Batch sizes for processing
  batchSizes: {
    buildings: 5000,      // Buildings processed per batch
    connections: 1000,    // Origin places per connection batch
  },
  
  // Retry settings for Overpass API
  retry: {
    maxAttempts: 3,
    baseDelay: 1000,     // 1 second, will exponentially increase (1s, 2s, 4s)
  },
  
  // Delay between Overpass requests (milliseconds)
  requestDelay: 2000,  // 2 seconds between tile requests
  
  // Delay between dataset fetches (roads -> buildings -> places)
  datasetDelay: 5000,  // 5 seconds between datasets
  
  // Maximum concurrent place downloads (keep at 1 to avoid rate limits)
  maxConcurrentDownloads: 1,
  
  // Streaming write chunk size (bytes)
  writeChunkSize: 1024 * 1024, // 1MB
  
  // Memory management
  memory: {
    // Recommended heap size for Node.js (in MB)
    // Adjust based on your available RAM
    recommendedHeapSize: {
      small: 4096,      // For cities < 500k buildings
      medium: 8192,     // For cities 500k-2M buildings
      large: 16384,     // For cities 2M-5M buildings
      xlarge: 32768,    // For cities > 5M buildings (e.g., Tokyo)
    }
  }
};

