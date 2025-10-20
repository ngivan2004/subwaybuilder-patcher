import fs from 'fs';
import config from '../config.js';
import perfConfig from '../performance_config.js';
import * as turf from '@turf/turf';
import { createParseStream } from 'big-json';
import cliProgress from 'cli-progress';
import RBush from 'rbush';
import StreamArray from 'stream-json/streamers/StreamArray.js';
import pkg from 'stream-chain';
const { chain } = pkg;
import Piscina from 'piscina';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== Lightweight Geometry Functions ====================

// Calculate polygon area using shoelace formula (square meters)
const calculateArea = (coords) => {
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    area += lon1 * lat2 - lon2 * lat1;
  }
  return Math.abs(area / 2) * 111320 * 111320 * Math.cos(coords[0][1] * Math.PI / 180);
};

// Calculate simple centroid
const calculateCentroid = (coords) => {
  let lonSum = 0, latSum = 0;
  const n = coords.length - 1; // Exclude closing point
  for (let i = 0; i < n; i++) {
    lonSum += coords[i][0];
    latSum += coords[i][1];
  }
  return [lonSum / n, latSum / n];
};

// Calculate distance between two points (meters)
const calculateDistance = (coord1, coord2) => {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Point-in-polygon test (ray casting)
const pointInPolygon = (point, polygon) => {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

// ==================== Data Structures ====================

const optimizeBuilding = (unOptimizedBuilding) => {
  // Create simple rectangle polygon from bounding box (4 corners instead of full geometry)
  const simplifiedPolygon = [[
    [unOptimizedBuilding.minX, unOptimizedBuilding.minY],
    [unOptimizedBuilding.maxX, unOptimizedBuilding.minY],
    [unOptimizedBuilding.maxX, unOptimizedBuilding.maxY],
    [unOptimizedBuilding.minX, unOptimizedBuilding.maxY],
    [unOptimizedBuilding.minX, unOptimizedBuilding.minY], // Close the polygon
  ]];
  
  return {
    b: [unOptimizedBuilding.minX, unOptimizedBuilding.minY, unOptimizedBuilding.maxX, unOptimizedBuilding.maxY],
    f: unOptimizedBuilding.foundationDepth,
    p: simplifiedPolygon,
  }
};

const optimizeIndex = (unOptimizedIndex) => {
  return {
    cs: unOptimizedIndex.cellHeightCoords,
    bbox: [unOptimizedIndex.minLon, unOptimizedIndex.minLat, unOptimizedIndex.maxLon, unOptimizedIndex.maxLat],
    grid: [unOptimizedIndex.cols, unOptimizedIndex.rows],
    cells: Object.keys(unOptimizedIndex.cells).map((key) => [...key.split(',').map((n) => Number(n)), ...unOptimizedIndex.cells[key]]),
    buildings: unOptimizedIndex.buildings.map((unOptimizedBuilding) => optimizeBuilding(unOptimizedBuilding)),
    stats: {
      count: unOptimizedIndex.buildings.length,
      maxDepth: unOptimizedIndex.maxDepth,
    }
  }
};

// ==================== Building Type Mappings ====================

const squareFeetPerPopulation = {
  yes: 600, apartments: 240, barracks: 100, bungalow: 600, cabin: 600,
  detached: 600, annexe: 240, dormitory: 125, farm: 600, ger: 240,
  hotel: 240, house: 600, houseboat: 600, residential: 600, semidetached_house: 400,
  static_caravan: 500, stilt_house: 600, terrace: 500, tree_house: 240, trullo: 240,
};

const squareFeetPerJob = {
  commercial: 150, industrial: 500, kiosk: 50, office: 150, retail: 300,
  supermarket: 300, warehouse: 500, religious: 100, cathedral: 100, chapel: 100,
  church: 100, kingdom_hall: 100, monastery: 100, mosque: 100, presbytery: 100,
  shrine: 100, synagogue: 100, temple: 100, bakehouse: 300, college: 250,
  fire_station: 500, government: 150, gatehouse: 150, hospital: 150, kindergarten: 100,
  museum: 300, public: 300, school: 100, train_station: 1000, transportation: 1000,
  university: 250, grandstand: 150, pavilion: 150, riding_hall: 150, sports_hall: 150,
  sports_centre: 150, stadium: 150,
};

const validPlaces = ['quarter', 'neighbourhood', 'suburb', 'hamlet', 'village'];

let terminalTicker = 0;

// ==================== Connection/Demand Processing (Optimized) ====================

const processPlaceConnections = async (place, rawBuildings, rawPlaces, progressBar) => {
  let neighborhoods = {};
  let centersOfNeighborhoods = {};
  let calculatedBuildings = {};

  progressBar.update(0, { stage: 'Finding neighborhoods' });

  // Extract neighborhoods
  rawPlaces.forEach((place) => {
    if (place.tags.place && (validPlaces.includes(place.tags.place)) || (place.tags.aeroway && place.tags.aeroway == 'terminal')) {
      neighborhoods[place.id] = place;
      if (place.type == 'node') {
        centersOfNeighborhoods[place.id] = [place.lon, place.lat];
      } else if (place.type == 'way' || place.type == 'relation') {
        const center = [(place.bounds.minlon + place.bounds.maxlon) / 2, (place.bounds.minlat + place.bounds.maxlat) / 2];
        centersOfNeighborhoods[place.id] = center;
      }
    }
  });

  const centersOfNeighborhoodsFeatureCollection = turf.featureCollection(
    Object.keys(centersOfNeighborhoods).map((placeID) =>
      turf.point(centersOfNeighborhoods[placeID], {
        placeID,
        name: neighborhoods[placeID].tags.name,
      })
    )
  );

  progressBar.update(10, { stage: 'Creating Voronoi' });

  // Create Voronoi
  const voronoi = turf.voronoi(centersOfNeighborhoodsFeatureCollection, {
    bbox: place.bbox,
  });
  voronoi.features = voronoi.features.filter((feature) => feature);

  progressBar.update(20, { stage: 'Processing buildings' });

  // Build spatial index for Voronoi polygons
  const voronoiIndex = new RBush();
  voronoi.features.forEach((feature, idx) => {
    const coords = feature.geometry.coordinates[0];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    coords.forEach(([x, y]) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
    voronoiIndex.insert({
      minX, minY, maxX, maxY,
      feature,
      coords,
    });
  });

  // Process buildings in batches
  const buildingBatchSize = perfConfig.batchSizes.buildings;
  let processedCount = 0;
  const startTime = Date.now();
  
  for (let i = 0; i < rawBuildings.length; i += buildingBatchSize) {
    const batch = rawBuildings.slice(i, i + buildingBatchSize);
    
    batch.forEach((building) => {
      if (!building.tags.building) return;
      
      const __coords = building.geometry.map((point) => [point.lon, point.lat]);
      if (__coords.length < 3) return;
      if (__coords[0][0] !== __coords[__coords.length - 1][0] || __coords[0][1] !== __coords[__coords.length - 1][1]) {
        __coords.push(__coords[0]);
      }

      // Use lightweight area calculation
      const buildingAreaSqMeters = calculateArea(__coords);
      let buildingAreaMultiplier = Math.max(Number(building.tags['building:levels']), 1);
      if (isNaN(buildingAreaMultiplier)) buildingAreaMultiplier = 1;
      const buildingArea = buildingAreaSqMeters * buildingAreaMultiplier * 10.7639; // to square feet

      // Use lightweight centroid
      const buildingCenter = calculateCentroid(__coords);

      if (squareFeetPerPopulation[building.tags.building]) {
        const approxPop = Math.floor(buildingArea / squareFeetPerPopulation[building.tags.building]);
        calculatedBuildings[building.id] = {
          ...building,
          approxPop,
          buildingCenter,
        };
      } else if (squareFeetPerJob[building.tags.building]) {
        let approxJobs = Math.floor(buildingArea / squareFeetPerJob[building.tags.building]);
        if (building.tags.aeroway && building.tags.aeroway == 'terminal') {
          approxJobs *= 20;
        }
        calculatedBuildings[building.id] = {
          ...building,
          approxJobs,
          buildingCenter,
        };
      }
    });
    
    processedCount += batch.length;
    const percent = 20 + Math.floor((processedCount / rawBuildings.length) * 30);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = processedCount > 0 ? Math.round((elapsed / processedCount) * (rawBuildings.length - processedCount)) : 0;
    progressBar.update(percent, { stage: `Buildings ${processedCount}/${rawBuildings.length} ETA:${eta}s` });
  }

  progressBar.update(50, { stage: 'Assigning to neighborhoods' });

  // Assign buildings to Voronoi cells using spatial index
  let finalVoronoiMembers = {};
  let finalVoronoiMetadata = {};

  voronoi.features.forEach((feature) => {
    finalVoronoiMembers[feature.properties.placeID] = [];
    finalVoronoiMetadata[feature.properties.placeID] = {
      ...feature.properties,
      totalPopulation: 0,
      totalJobs: 0,
      percentOfTotalPopulation: null,
      percentOfTotalJobs: null,
    };
  });

  // Use spatial index for assignment
  let assignedCount = 0;
  const assignStartTime = Date.now();
  Object.values(calculatedBuildings).forEach((building) => {
    const [lon, lat] = building.buildingCenter;
    
    // Query spatial index for candidate polygons
    const candidates = voronoiIndex.search({
      minX: lon, minY: lat, maxX: lon, maxY: lat,
    });

    // Test point-in-polygon for candidates
    for (const candidate of candidates) {
      if (pointInPolygon(building.buildingCenter, candidate.coords)) {
        const placeID = candidate.feature.properties.placeID;
        finalVoronoiMembers[placeID].push(building);
        finalVoronoiMetadata[placeID].totalPopulation += (building.approxPop ?? 0);
        finalVoronoiMetadata[placeID].totalJobs += (building.approxJobs ?? 0);
        break;
      }
    }
    
    assignedCount++;
    if (assignedCount % 5000 === 0) {
      const percent = 50 + Math.floor((assignedCount / Object.keys(calculatedBuildings).length) * 20);
      const elapsed = (Date.now() - assignStartTime) / 1000;
      const eta = assignedCount > 0 ? Math.round((elapsed / assignedCount) * (Object.keys(calculatedBuildings).length - assignedCount)) : 0;
      progressBar.update(percent, { stage: `Assign ${assignedCount}/${Object.keys(calculatedBuildings).length} ETA:${eta}s` });
    }
  });

  progressBar.update(70, { stage: 'Computing totals' });

  // Calculate totals
  let totalPopulation = 0;
  let totalJobs = 0;
  Object.values(finalVoronoiMetadata).forEach((meta) => {
    totalPopulation += meta.totalPopulation;
    totalJobs += meta.totalJobs;
  });

  // Set percentages
  Object.values(finalVoronoiMetadata).forEach((place) => {
    finalVoronoiMetadata[place.placeID].percentOfTotalPopulation = place.totalPopulation / totalPopulation || 0;
    finalVoronoiMetadata[place.placeID].percentOfTotalJobs = place.totalJobs / totalJobs || 0;
  });

  progressBar.update(75, { stage: 'Creating neighborhoods' });

  let finalNeighborhoods = {};
  Object.values(finalVoronoiMetadata).forEach((place) => {
    let id = place.placeID;

    if (neighborhoods[id] && neighborhoods[id].tags && neighborhoods[id].tags.aeroway && neighborhoods[id].tags.aeroway == 'terminal') {
      id = "AIR_Terminal_" + terminalTicker;
      terminalTicker++;
    }

    finalNeighborhoods[place.placeID] = {
      id: id,
      location: centersOfNeighborhoods[place.placeID],
      jobs: place.totalJobs,
      residents: place.totalPopulation,
      popIds: [],
    };
  });

  progressBar.update(80, { stage: 'Computing connections' });

  // Compute connections in parallel with preserved totals
  const places = Object.values(finalVoronoiMetadata);
  
  // Create worker pool for demand calculation
  const workerCount = perfConfig.workerThreads > 0 ? perfConfig.workerThreads : Math.max(1, os.cpus().length - 1);
  const demandPool = new Piscina({
    filename: join(__dirname, 'demand_worker.js'),
    minThreads: workerCount,
    maxThreads: workerCount,
  });

  // Split origin places into batches for parallel processing
  const demandBatchSize = Math.ceil(places.length / workerCount);
  const tasks = [];

  for (let i = 0; i < places.length; i += demandBatchSize) {
    const batch = places.slice(i, i + demandBatchSize);
    tasks.push(
      demandPool.run({
        originPlaces: batch,
        allPlaces: places,
        centersOfNeighborhoods,
      })
    );
  }

  const connectionResults = await Promise.all(tasks);
  await demandPool.destroy();

  // Merge connection results
  let neighborhoodConnections = [];
  connectionResults.forEach(batchConnections => {
    // Use for loop for very large arrays (safer than spread or apply)
    for (let j = 0; j < batchConnections.length; j++) {
      neighborhoodConnections.push(batchConnections[j]);
    }
  });

  progressBar.update(95, { stage: 'Finalizing connections' });

  // Filter and assign IDs
  neighborhoodConnections = neighborhoodConnections
    .filter((connection) => connection.size > 0)
    .map((connection, i) => {
      const id = i.toString();
      finalNeighborhoods[connection.jobId].popIds.push(id);
      finalNeighborhoods[connection.residenceId].popIds.push(id);
      return {
        ...connection,
        id,
      };
    });

  // Handle airport terminals
  neighborhoodConnections.forEach((connection) => {
    connection.residenceId = finalNeighborhoods[connection.residenceId].id;
    connection.jobId = finalNeighborhoods[connection.jobId].id;
  });

  progressBar.update(100, { stage: 'Connections complete' });

  // Calculate statistics
  const stats = {
    totalPopulation,
    totalJobs,
    neighborhoods: Object.keys(finalNeighborhoods).length,
    connections: neighborhoodConnections.length,
    avgConnectionSize: Math.round(neighborhoodConnections.reduce((sum, c) => sum + c.size, 0) / neighborhoodConnections.length),
    totalMovement: neighborhoodConnections.reduce((sum, c) => sum + c.size, 0),
  };

  return {
    points: Object.values(finalNeighborhoods),
    pops: neighborhoodConnections,
    stats,
  };
};

// ==================== Building Processing (Optimized with Workers) ====================

const processBuildings = async (place, rawBuildings, progressBar) => {
  let minLon = 9999, minLat = 9999, maxLon = -999, maxLat = -999;

  progressBar.update(0, { stage: 'Calculating bounds' });

  // First pass: find overall bounding box (fast, sequential)
  rawBuildings.forEach((building) => {
    building.geometry.forEach((coord) => {
      if (coord.lon < minLon) minLon = coord.lon;
      if (coord.lat < minLat) minLat = coord.lat;
      if (coord.lon > maxLon) maxLon = coord.lon;
      if (coord.lat > maxLat) maxLat = coord.lat;
    });
  });

  progressBar.update(10, { stage: 'Creating grid' });

  // Calculate grid dimensions
  const horizontalDistance = calculateDistance([minLon, minLat], [maxLon, minLat]);
  const verticalDistance = calculateDistance([minLon, minLat], [minLon, maxLat]);

  const cellSizeMeters = 100;
  const cols = Math.ceil(horizontalDistance / cellSizeMeters);
  const rows = Math.ceil(verticalDistance / cellSizeMeters);

  const cellWidth = (maxLon - minLon) / cols;
  const cellHeight = (maxLat - minLat) / rows;

  progressBar.update(20, { stage: 'Processing in parallel' });

  // Create worker pool
  const workerCount = perfConfig.workerThreads > 0 ? perfConfig.workerThreads : Math.max(1, os.cpus().length - 1);
  const pool = new Piscina({
    filename: join(__dirname, 'building_worker.js'),
    minThreads: workerCount,
    maxThreads: workerCount,
  });

  // Process buildings in parallel batches
  const batchSize = Math.ceil(rawBuildings.length / workerCount);
  const tasks = [];
  
  for (let i = 0; i < rawBuildings.length; i += batchSize) {
    const batch = rawBuildings.slice(i, i + batchSize);
    tasks.push(
      pool.run({
        buildings: batch,
        startIdx: i,
        minLon, maxLon, minLat, maxLat,
        cellWidth, cellHeight, cols, rows,
      })
    );
  }

  const results = await Promise.all(tasks);
  await pool.destroy();

  // Merge results
  let processedBuildings = {};
  results.forEach(batchResult => {
    batchResult.forEach(building => {
      processedBuildings[building.id] = building;
    });
  });

  progressBar.update(70, { stage: 'Building cells' });

  // Build cells dictionary
  let cellsDict = {};
  Object.values(processedBuildings).forEach((building) => {
    const buildingCoord = `${building.xCellCoord},${building.yCellCoord}`;
    if (!cellsDict[buildingCoord]) cellsDict[buildingCoord] = [];
    cellsDict[buildingCoord].push(building.id);
  });

  progressBar.update(90, { stage: 'Optimizing output' });

  let maxDepth = 1;
  const optimizedIndex = optimizeIndex({
    cellHeightCoords: cellHeight,
    minLon, minLat, maxLon, maxLat,
    cols, rows,
    cells: cellsDict,
    buildings: Object.values(processedBuildings).map((building) => {
      if (building.tags['building:levels:underground'] && Number(building.tags['building:levels:underground']) > maxDepth) {
        maxDepth = Number(building.tags['building:levels:underground']);
      }
      // Create simple rectangle polygon from bounding box
      const simplePolygon = [[
        [building.bbox.minLon, building.bbox.minLat],
        [building.bbox.maxLon, building.bbox.minLat],
        [building.bbox.maxLon, building.bbox.maxLat],
        [building.bbox.minLon, building.bbox.maxLat],
        [building.bbox.minLon, building.bbox.minLat],
      ]];

      return {
        minX: building.bbox.minLon,
        minY: building.bbox.minLat,
        maxX: building.bbox.maxLon,
        maxY: building.bbox.maxLat,
        foundationDepth: building.tags['building:levels:underground'] ? Number(building.tags['building:levels:underground']) : 1,
        polygon: simplePolygon,
      };
    }),
    maxDepth,
  });

  progressBar.update(100, { stage: 'Buildings complete' });
  return optimizedIndex;
};

// ==================== Streaming JSON Utilities ====================

const readJsonFileStreaming = (filePath) => {
    return new Promise((resolve, reject) => {
      const parseStream = createParseStream();
      let jsonData;

      parseStream.on('data', (data) => {
        jsonData = data;
      });

      parseStream.on('end', () => {
        resolve(jsonData);
      });

      parseStream.on('error', (err) => {
        reject(err);
      });

      fs.createReadStream(filePath).pipe(parseStream);
    });
  };

// Stream large JSON arrays in chunks
const streamJsonArray = (filePath, onChunk, chunkSize = perfConfig.batchSizes.buildings) => {
  return new Promise((resolve, reject) => {
    const pipeline = chain([
      fs.createReadStream(filePath),
      StreamArray.withParser(),
    ]);

    let buffer = [];
    let totalProcessed = 0;

    pipeline.on('data', (data) => {
      buffer.push(data.value);
      
      if (buffer.length >= chunkSize) {
        const chunk = buffer;
        buffer = [];
        totalProcessed += chunk.length;
        onChunk(chunk, totalProcessed);
      }
    });

    pipeline.on('end', () => {
      if (buffer.length > 0) {
        totalProcessed += buffer.length;
        onChunk(buffer, totalProcessed);
      }
      resolve(totalProcessed);
    });

    pipeline.on('error', reject);
  });
};

// Write JSON in batches for performance with progress tracking
const writeJsonFileStreaming = (filePath, data, progressCallback) => {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }); // 1MB buffer
    
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    
    // Handle objects with specific structure (buildings_index, demand_data)
    if (data && typeof data === 'object') {
      writeStream.write('{');
      const keys = Object.keys(data);
      
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (i > 0) writeStream.write(',');
        
        writeStream.write(`"${key}":`);
        
        // If value is an array, stream it element by element
        if (Array.isArray(data[key])) {
          writeStream.write('[');
          
          for (let j = 0; j < data[key].length; j++) {
            if (j > 0) writeStream.write(',');
            writeStream.write(JSON.stringify(data[key][j]));
            
            if (progressCallback && j % 5000 === 0 && data[key].length > 10000) {
              progressCallback(key, j, data[key].length);
            }
          }
          
          writeStream.write(']');
          if (progressCallback && data[key].length > 10000) {
            progressCallback(key, data[key].length, data[key].length);
          }
        } else {
          // For non-array values, stringify normally
          writeStream.write(JSON.stringify(data[key]));
        }
      }
      
      writeStream.end('}', resolve);
    } else {
      // Fallback for simple data
      try {
        writeStream.end(JSON.stringify(data), resolve);
      } catch (error) {
        reject(error);
      }
    }
  });
};

// ==================== Main Processing ====================

const processAllData = async (place) => {

  console.log(`\nProcessing ${place.code}`);
  
  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    format: ' {stage} | {bar} | {percentage}%',
  }, cliProgress.Presets.shades_classic);

  const buildingBar = multibar.create(100, 0, { stage: 'Buildings' });
  const connectionBar = multibar.create(100, 0, { stage: 'Connections' });

  try {
    console.log('  Reading raw data...');
    const rawBuildings = await readJsonFileStreaming(`./raw_data/${place.code}/buildings.json`);
    const rawPlaces = await readJsonFileStreaming(`./raw_data/${place.code}/places.json`);

    const processedBuildings = await processBuildings(place, rawBuildings, buildingBar);
    const processedConnections = await processPlaceConnections(place, rawBuildings, rawPlaces, connectionBar);

    multibar.stop();

    // Log statistics
    if (processedConnections.stats) {
      console.log('\n  📊 Statistics:');
      console.log(`    Population:     ${processedConnections.stats.totalPopulation.toLocaleString()}`);
      console.log(`    Jobs:           ${processedConnections.stats.totalJobs.toLocaleString()}`);
      console.log(`    Neighborhoods:  ${processedConnections.stats.neighborhoods}`);
      console.log(`    Connections:    ${processedConnections.stats.connections.toLocaleString()}`);
      console.log(`    Total Movement: ${processedConnections.stats.totalMovement.toLocaleString()} people`);
      console.log(`    Avg Connection: ${processedConnections.stats.avgConnectionSize} people`);
      console.log(`    Buildings:      ${processedBuildings.stats.count.toLocaleString()}\n`);
    }

    console.log('  Writing output files...');
    
    process.stdout.write('    Writing buildings index... ');
    await writeJsonFileStreaming(
      `./processed_data/${place.code}/buildings_index.json`, 
      processedBuildings,
      (key, current, total) => {
        process.stdout.write(`\r    Writing buildings ${key}... ${current}/${total}`);
      }
    );
    console.log('\r    ✓ Buildings index written     ');
    
  fs.cpSync(`./raw_data/${place.code}/roads.geojson`, `./processed_data/${place.code}/roads.geojson`);
    console.log('    ✓ Roads copied');
    
    process.stdout.write('    Writing demand data... ');
    await writeJsonFileStreaming(
      `./processed_data/${place.code}/demand_data.json`, 
      processedConnections,
      (key, current, total) => {
        process.stdout.write(`\r    Writing ${key}... ${current}/${total}`);
      }
    );
    console.log('\r    ✓ Demand data written     ');

    console.log(`✓ Finished processing ${place.code}`);
    
    // Return stats for summary
    return {
      totalPopulation: processedConnections.stats?.totalPopulation || 0,
      totalJobs: processedConnections.stats?.totalJobs || 0,
      neighborhoods: processedConnections.stats?.neighborhoods || 0,
      connections: processedConnections.stats?.connections || 0,
      buildings: processedBuildings.stats?.count || 0,
      totalMovement: processedConnections.stats?.totalMovement || 0,
    };
  } catch (error) {
    multibar.stop();
    console.error(`✗ Error processing ${place.code}:`, error.message);
    throw error;
  }
};

// ==================== Main Execution ====================

if (!fs.existsSync('./processed_data')) fs.mkdirSync('./processed_data');

// Process places sequentially for now (could parallelize later)
const processPlaces = async () => {
  const allStats = [];
  
  for (const place of config.places) {
    if (fs.existsSync(`./processed_data/${place.code}`)) {
      fs.rmSync(`./processed_data/${place.code}`, { recursive: true, force: true });
    }
    fs.mkdirSync(`./processed_data/${place.code}`);
    const stats = await processAllData(place);
    if (stats) {
      allStats.push({ place: place.name, ...stats });
    }
  }
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('✓ All processing complete!');
  console.log('='.repeat(60));
  
  if (allStats.length > 0) {
    console.log('\n📊 Grand Total Summary:\n');
    const totals = allStats.reduce((acc, stat) => ({
      population: acc.population + (stat.totalPopulation || 0),
      jobs: acc.jobs + (stat.totalJobs || 0),
      neighborhoods: acc.neighborhoods + (stat.neighborhoods || 0),
      connections: acc.connections + (stat.connections || 0),
      buildings: acc.buildings + (stat.buildings || 0),
      movement: acc.movement + (stat.totalMovement || 0),
    }), { population: 0, jobs: 0, neighborhoods: 0, connections: 0, buildings: 0, movement: 0 });
    
    console.log(`  Total Population:    ${totals.population.toLocaleString()}`);
    console.log(`  Total Jobs:          ${totals.jobs.toLocaleString()}`);
    console.log(`  Total Buildings:     ${totals.buildings.toLocaleString()}`);
    console.log(`  Total Neighborhoods: ${totals.neighborhoods.toLocaleString()}`);
    console.log(`  Total Connections:   ${totals.connections.toLocaleString()}`);
    console.log(`  Total Movement:      ${totals.movement.toLocaleString()} people/day`);
    console.log(`\n  Places Processed:    ${allStats.length}`);
    console.log('\n' + '='.repeat(60) + '\n');
  }
};

processPlaces().catch((error) => {
  console.error('\n✗ Processing failed:', error);
  process.exit(1);
});
