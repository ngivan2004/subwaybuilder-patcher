import fs from 'fs';
import config from '../config.js';
import perfConfig from '../performance_config.js';
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
import { decode as msgpackDecode } from '@msgpack/msgpack';

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

// Centroid removed - we now use fast bbox center for neighborhood assignment

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

const optimizeIndex = async (unOptimizedIndex, progressBar) => {
  // Optimize cells (fast, no batching needed)
  const optimizedCells = Object.keys(unOptimizedIndex.cells).map((key) => 
    [...key.split(',').map((n) => Number(n)), ...unOptimizedIndex.cells[key]]
  );
  
  // Optimize buildings in batches with progress (slow, needs batching!)
  const optimizedBuildings = [];
  const batchSize = 50000;
  const totalBatches = Math.ceil(unOptimizedIndex.buildings.length / batchSize);
  
  for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
    const startIdx = batchNum * batchSize;
    const endIdx = Math.min(startIdx + batchSize, unOptimizedIndex.buildings.length);
    
    for (let i = startIdx; i < endIdx; i++) {
      optimizedBuildings.push(optimizeBuilding(unOptimizedIndex.buildings[i]));
    }
    
    // Update progress (95-100%)
    const progress = 95 + Math.floor((batchNum + 1) / totalBatches * 5);
    if (progressBar) {
      progressBar.update(progress, { 
        stage: `Finalizing batch ${batchNum + 1}/${totalBatches} (${endIdx.toLocaleString()}/${unOptimizedIndex.buildings.length.toLocaleString()})` 
      });
    }
    
    // Yield to event loop
    await new Promise(resolve => setImmediate(resolve));
  }
  
  return {
    cs: unOptimizedIndex.cellHeightCoords,
    bbox: [unOptimizedIndex.minLon, unOptimizedIndex.minLat, unOptimizedIndex.maxLon, unOptimizedIndex.maxLat],
    grid: [unOptimizedIndex.cols, unOptimizedIndex.rows],
    cells: optimizedCells,
    buildings: optimizedBuildings,
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

  // Grid-based neighborhood assignment with spatial index optimization!
  progressBar.update(5, { stage: 'Building neighborhood index' });
  console.log(`  Building optimized grid for ${Object.keys(centersOfNeighborhoods).length} neighborhoods...`);
  
  const gridStart = Date.now();
  
  // STEP 1: Build spatial index on neighborhoods (fast!)
  const neighborhoodIndex = new RBush();
  const neighborhoodList = Object.keys(centersOfNeighborhoods).map(id => {
    const [lon, lat] = centersOfNeighborhoods[id];
    return {
      minX: lon, minY: lat,
      maxX: lon, maxY: lat,
      id,
      center: [lon, lat]
    };
  });
  neighborhoodIndex.load(neighborhoodList);
  console.log(`  ✓ Spatial index built for ${neighborhoodList.length} neighborhoods`);
  
  // STEP 2: Build grid with spatial index queries (much faster!)
  const [minLon, minLat, maxLon, maxLat] = place.bbox;
  const gridResolution = 0.002; // 200m resolution for good accuracy
  const gridCols = Math.ceil((maxLon - minLon) / gridResolution);
  const gridRows = Math.ceil((maxLat - minLat) / gridResolution);
  const totalGridCells = gridCols * gridRows;
  
  console.log(`  Grid: ${gridCols} × ${gridRows} = ${totalGridCells.toLocaleString()} cells at ~200m resolution`);
  
  const neighborhoodGrid = new Map();
  const searchRadius = 0.05; // Search within ~5km radius for candidates
  
  // Precompute grid in batches with progress
  const gridBatchSize = 5000; // Process 5000 grid cells at a time
  const totalGridBatches = Math.ceil(totalGridCells / gridBatchSize);
  let cellsProcessed = 0;
  
  for (let batchNum = 0; batchNum < totalGridBatches; batchNum++) {
    const batchStart = batchNum * gridBatchSize;
    const batchEnd = Math.min(batchStart + gridBatchSize, totalGridCells);
    
    for (let cellIdx = batchStart; cellIdx < batchEnd; cellIdx++) {
      const row = Math.floor(cellIdx / gridCols);
      const col = cellIdx % gridCols;
      const lon = minLon + col * gridResolution;
      const lat = minLat + row * gridResolution;
      
      // Query spatial index for nearby neighborhoods (only ~5-20 instead of 25k!)
      const candidates = neighborhoodIndex.search({
        minX: lon - searchRadius,
        minY: lat - searchRadius,
        maxX: lon + searchRadius,
        maxY: lat + searchRadius
      });
      
      // Find nearest among candidates
      let nearestId = null;
      let minDistSq = Infinity;
      
      for (const neighborhood of candidates) {
        const [nLon, nLat] = neighborhood.center;
        const dLon = lon - nLon;
        const dLat = lat - nLat;
        const distSq = dLon * dLon + dLat * dLat;
        
        if (distSq < minDistSq) {
          minDistSq = distSq;
          nearestId = neighborhood.id;
        }
      }
      
      if (nearestId) {
        neighborhoodGrid.set(`${col},${row}`, nearestId);
      }
    }
    
    cellsProcessed = batchEnd;
    
    // Update progress (5-15%)
    const progress = 5 + Math.floor((cellsProcessed / totalGridCells) * 10);
    progressBar.update(progress, { 
      stage: `Grid ${cellsProcessed.toLocaleString()}/${totalGridCells.toLocaleString()}` 
    });
    
    // Yield to event loop every batch
    if (batchNum % 50 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  const gridTime = ((Date.now() - gridStart) / 1000).toFixed(1);
  console.log(`  ✓ Grid built in ${gridTime}s (${totalGridCells.toLocaleString()} cells)`);

  progressBar.update(20, { stage: 'Processing buildings' });

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

      // Use exact area calculation for accurate population
      const buildingAreaSqMeters = calculateArea(__coords);
      let buildingAreaMultiplier = Math.max(Number(building.tags['building:levels']), 1);
      if (isNaN(buildingAreaMultiplier)) buildingAreaMultiplier = 1;
      const buildingArea = buildingAreaSqMeters * buildingAreaMultiplier * 10.7639; // to square feet

      // Fast bbox center for neighborhood assignment (don't need exact centroid!)
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [lon, lat] of __coords) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      const buildingCenter = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];

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

  // Initialize neighborhood data structures
  let finalVoronoiMembers = {};
  let finalVoronoiMetadata = {};

  Object.keys(neighborhoods).forEach((placeID) => {
    finalVoronoiMembers[placeID] = [];
    finalVoronoiMetadata[placeID] = {
      placeID,
      name: neighborhoods[placeID].tags.name,
      totalPopulation: 0,
      totalJobs: 0,
      percentOfTotalPopulation: null,
      percentOfTotalJobs: null,
    };
  });

  // Assign buildings using grid lookup (super fast!)
  let assignedCount = 0;
  const assignStartTime = Date.now();
  const buildingList = Object.values(calculatedBuildings);
  
  for (let i = 0; i < buildingList.length; i++) {
    const building = buildingList[i];
    const [lon, lat] = building.buildingCenter;
    
    // Convert building coordinates to grid cell
    const col = Math.floor((lon - minLon) / gridResolution);
    const row = Math.floor((lat - minLat) / gridResolution);
    const placeID = neighborhoodGrid.get(`${col},${row}`);
    
    // Assign building to neighborhood
    if (placeID && finalVoronoiMembers[placeID]) {
      finalVoronoiMembers[placeID].push(building);
      finalVoronoiMetadata[placeID].totalPopulation += (building.approxPop ?? 0);
      finalVoronoiMetadata[placeID].totalJobs += (building.approxJobs ?? 0);
    }
    
    assignedCount++;
    if (assignedCount % 10000 === 0) {
      const percent = 50 + Math.floor((assignedCount / buildingList.length) * 20);
      const elapsed = (Date.now() - assignStartTime) / 1000;
      const eta = assignedCount > 0 ? Math.round((elapsed / assignedCount) * (buildingList.length - assignedCount)) : 0;
      progressBar.update(percent, { stage: `Assign ${assignedCount.toLocaleString()}/${buildingList.length.toLocaleString()} ETA:${eta}s` });
    }
    
    // Yield to event loop every 50k buildings
    if (assignedCount % 50000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  const assignTime = ((Date.now() - assignStartTime) / 1000).toFixed(1);
  console.log(`  ✓ Assigned ${assignedCount.toLocaleString()} buildings in ${assignTime}s`);

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
  const workerCount = perfConfig.workerThreads > 0 ? perfConfig.workerThreads : 
                      perfConfig.workerThreads === -1 ? os.cpus().length : 
                      Math.max(1, os.cpus().length - 1);
  const demandPool = new Piscina({
    filename: join(__dirname, 'demand_worker.js'),
    minThreads: workerCount,
    maxThreads: workerCount,
  });

  // Process connections in smaller batches with progress updates
  const demandBatchSize = 100; // Process 100 neighborhoods at a time
  const totalDemandBatches = Math.ceil(places.length / demandBatchSize);
  let neighborhoodConnections = [];
  
  for (let batchNum = 0; batchNum < totalDemandBatches; batchNum++) {
    const startIdx = batchNum * demandBatchSize;
    const batch = places.slice(startIdx, startIdx + demandBatchSize);
    
    // Split across workers
    const workerBatchSize = Math.ceil(batch.length / workerCount);
    const workerTasks = [];
    
    for (let i = 0; i < batch.length; i += workerBatchSize) {
      const workerBatch = batch.slice(i, i + workerBatchSize);
      workerTasks.push(
        demandPool.run({
          originPlaces: workerBatch,
          allPlaces: places,
          centersOfNeighborhoods,
        })
      );
    }
    
    const results = await Promise.all(workerTasks);
    
    // Merge results from this batch
    results.forEach(batchConnections => {
      for (let j = 0; j < batchConnections.length; j++) {
        neighborhoodConnections.push(batchConnections[j]);
      }
    });
    
    // Update progress (0% to 90% range)
    const progress = Math.floor((batchNum + 1) / totalDemandBatches * 90);
    const processed = Math.min(startIdx + batch.length, places.length);
    progressBar.update(progress, { 
      stage: `Computing ${processed.toLocaleString()}/${places.length.toLocaleString()} connections` 
    });
  }
  
  await demandPool.destroy();

  progressBar.update(90, { stage: 'Finalizing connections' });

  // Filter and assign IDs in batches (millions of connections!)
  const filteredConnections = [];
  const filterBatchSize = 100000; // Process 100k at a time
  const totalFilterBatches = Math.ceil(neighborhoodConnections.length / filterBatchSize);
  
  let idCounter = 0;
  for (let batchNum = 0; batchNum < totalFilterBatches; batchNum++) {
    const startIdx = batchNum * filterBatchSize;
    const batch = neighborhoodConnections.slice(startIdx, startIdx + filterBatchSize);
    
    batch.forEach((connection) => {
      if (connection.size > 0) {
        const id = idCounter.toString();
        finalNeighborhoods[connection.jobId].popIds.push(id);
        finalNeighborhoods[connection.residenceId].popIds.push(id);
        filteredConnections.push({
          ...connection,
          id,
        });
        idCounter++;
      }
    });
    
    // Update progress (90-97%)
    const progress = 90 + Math.floor((batchNum + 1) / totalFilterBatches * 7);
    const processed = Math.min(startIdx + batch.length, neighborhoodConnections.length);
    progressBar.update(progress, { 
      stage: `Filtering ${processed.toLocaleString()}/${neighborhoodConnections.length.toLocaleString()}` 
    });
    
    // Yield to event loop
    await new Promise(resolve => setImmediate(resolve));
  }
  
  neighborhoodConnections = filteredConnections;

  progressBar.update(97, { stage: 'Mapping terminals' });

  // Handle airport terminals in batches
  const terminalBatchSize = 50000;
  const totalTerminalBatches = Math.ceil(neighborhoodConnections.length / terminalBatchSize);
  
  for (let batchNum = 0; batchNum < totalTerminalBatches; batchNum++) {
    const startIdx = batchNum * terminalBatchSize;
    const endIdx = Math.min(startIdx + terminalBatchSize, neighborhoodConnections.length);
    
    for (let i = startIdx; i < endIdx; i++) {
      const connection = neighborhoodConnections[i];
      connection.residenceId = finalNeighborhoods[connection.residenceId].id;
      connection.jobId = finalNeighborhoods[connection.jobId].id;
    }
    
    // Update progress (97-100%)
    const progress = 97 + Math.floor((batchNum + 1) / totalTerminalBatches * 3);
    progressBar.update(progress, { 
      stage: `Terminals ${endIdx.toLocaleString()}/${neighborhoodConnections.length.toLocaleString()}` 
    });
    
    // Yield to event loop
    await new Promise(resolve => setImmediate(resolve));
  }

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

  // First pass: find overall bounding box with progress updates
  const updateInterval = Math.floor(rawBuildings.length / 100); // Update every 1%
  rawBuildings.forEach((building, idx) => {
    building.geometry.forEach((coord) => {
      if (coord.lon < minLon) minLon = coord.lon;
      if (coord.lat < minLat) minLat = coord.lat;
      if (coord.lon > maxLon) maxLon = coord.lon;
      if (coord.lat > maxLat) maxLat = coord.lat;
    });
    
    // Update progress every 1% (every ~50k buildings for Tokyo)
    if (idx % updateInterval === 0) {
      const progress = Math.floor((idx / rawBuildings.length) * 10);
      progressBar.update(progress, { 
        stage: `Calculating bounds ${idx.toLocaleString()}/${rawBuildings.length.toLocaleString()}` 
      });
    }
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
  const workerCount = perfConfig.workerThreads > 0 ? perfConfig.workerThreads : 
                      perfConfig.workerThreads === -1 ? os.cpus().length : 
                      Math.max(1, os.cpus().length - 1);
  const pool = new Piscina({
    filename: join(__dirname, 'building_worker.js'),
    minThreads: workerCount,
    maxThreads: workerCount,
  });

  // Process buildings in smaller batches with progress updates
  // Use smaller batch size to reduce memory usage
  const batchSize = 50000; // Process 50k buildings at a time
  const totalBatches = Math.ceil(rawBuildings.length / batchSize);
  let processedBuildings = {};
  
  console.log(`  Parallel processing ${totalBatches} batches with ${workerCount} workers...`);
  const startTime = Date.now();
  
  for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
    const batchStartTime = Date.now();
    const startIdx = batchNum * batchSize;
    const batch = rawBuildings.slice(startIdx, startIdx + batchSize);
    
    // Split this batch across workers
    const workerBatchSize = Math.ceil(batch.length / workerCount);
    const workerTasks = [];
    
    for (let i = 0; i < batch.length; i += workerBatchSize) {
      const workerBatch = batch.slice(i, i + workerBatchSize);
      workerTasks.push(
        pool.run({
          buildings: workerBatch,
          startIdx: startIdx + i,
          minLon, maxLon, minLat, maxLat,
          cellWidth, cellHeight, cols, rows,
        })
      );
    }
    
    const results = await Promise.all(workerTasks);
    
    // Merge results from this batch
    results.forEach(batchResult => {
      batchResult.forEach(building => {
        processedBuildings[building.id] = building;
      });
    });
    
    // Update progress (20% to 70% range) - show every batch!
    const progress = 20 + Math.floor((batchNum + 1) / totalBatches * 50);
    const processed = Math.min(startIdx + batch.length, rawBuildings.length);
    const batchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const memUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    
    progressBar.update(progress, { 
      stage: `Batch ${batchNum + 1}/${totalBatches}: ${processed.toLocaleString()}/${rawBuildings.length.toLocaleString()} [${batchTime}s, ${memUsed}MB]` 
    });
  }

  await pool.destroy();
  
  // Log memory before cells phase
  const memBeforeCells = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`  Memory before building cells: ${memBeforeCells} MB`);

  progressBar.update(70, { stage: 'Extracting building IDs' });
  
  // Build cells dictionary in BATCHES to avoid memory spike
  let cellsDict = {};
  const buildingIdsForCells = Object.keys(processedBuildings);
  const cellBatchSize = 25000; // Process 25k at a time (smaller = more frequent updates)
  const totalCellBatches = Math.ceil(buildingIdsForCells.length / cellBatchSize);
  console.log(`  Extracted ${buildingIdsForCells.length.toLocaleString()} building IDs, creating ${totalCellBatches} batches...`);
  
  progressBar.update(70, { stage: 'Building cells (starting)' });
  
  for (let batchNum = 0; batchNum < totalCellBatches; batchNum++) {
    const startIdx = batchNum * cellBatchSize;
    const endIdx = Math.min(startIdx + cellBatchSize, buildingIdsForCells.length);
    
    for (let i = startIdx; i < endIdx; i++) {
      const id = buildingIdsForCells[i];
      const building = processedBuildings[id];
    const buildingCoord = `${building.xCellCoord},${building.yCellCoord}`;
    if (!cellsDict[buildingCoord]) cellsDict[buildingCoord] = [];
    cellsDict[buildingCoord].push(building.id);
    }
    
    // Update progress every batch (70-90%)
    const progress = 70 + Math.floor((batchNum + 1) / totalCellBatches * 20);
    progressBar.update(progress, { 
      stage: `Building cells batch ${batchNum + 1}/${totalCellBatches} (${endIdx.toLocaleString()}/${buildingIdsForCells.length.toLocaleString()})` 
    });
    
    // Yield to event loop so progress bar can render
    await new Promise(resolve => setImmediate(resolve));
  }
  
  const memAfterCells = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`  Memory after building cells: ${memAfterCells} MB (Δ +${memAfterCells - memBeforeCells} MB)`);

  const memBeforeOptimize = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`  Memory before optimizing: ${memBeforeOptimize} MB`);
  
  progressBar.update(90, { stage: 'Optimizing output' });

  // Optimize buildings in batches to avoid memory overflow
  let maxDepth = 1;
  const optimizedBuildings = [];
  const buildingIdsForOptimize = Object.keys(processedBuildings);
  const optimizeBatchSize = 100000; // Process 100k at a time
  const totalOptimizeBatches = Math.ceil(buildingIdsForOptimize.length / optimizeBatchSize);
  
  for (let batchNum = 0; batchNum < totalOptimizeBatches; batchNum++) {
    const startIdx = batchNum * optimizeBatchSize;
    const batchIds = buildingIdsForOptimize.slice(startIdx, startIdx + optimizeBatchSize);
    
    batchIds.forEach(id => {
      const building = processedBuildings[id];
      
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

      optimizedBuildings.push({
        minX: building.bbox.minLon,
        minY: building.bbox.minLat,
        maxX: building.bbox.maxLon,
        maxY: building.bbox.maxLat,
        foundationDepth: building.tags['building:levels:underground'] ? Number(building.tags['building:levels:underground']) : 1,
        polygon: simplePolygon,
      });
      
      // Release memory as we go
      delete processedBuildings[id];
    });
    
    // Update progress (90-95%)
    const progress = 90 + Math.floor((batchNum + 1) / totalOptimizeBatches * 5);
    const processed = Math.min(startIdx + optimizeBatchSize, buildingIdsForOptimize.length);
    const memUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    progressBar.update(progress, { 
      stage: `Optimize batch ${batchNum + 1}/${totalOptimizeBatches}: ${processed.toLocaleString()}/${buildingIdsForOptimize.length.toLocaleString()} [${memUsed}MB]` 
    });
    
    // Yield to event loop so progress bar can render and GC can run
    await new Promise(resolve => setImmediate(resolve));
  }
  
  const memAfterOptimize = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`  Memory after optimizing: ${memAfterOptimize} MB (Δ ${memAfterOptimize - memBeforeOptimize} MB)`);
  
  // Now processedBuildings is empty, much less memory used!
  progressBar.update(95, { stage: 'Finalizing index' });
  
  const optimizedIndex = await optimizeIndex({
    cellHeightCoords: cellHeight,
    minLon, minLat, maxLon, maxLat,
    cols, rows,
    cells: cellsDict,
    buildings: optimizedBuildings,
    maxDepth,
  }, progressBar);

  progressBar.update(100, { stage: 'Buildings complete' });
  return optimizedIndex;
};

// ==================== Streaming JSON Utilities ====================

// Read MessagePack binary (10x faster than JSON streaming!)
const readMsgpackBinary = async (filePath) => {
  const binary = fs.readFileSync(filePath);
  return msgpackDecode(binary);
};

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
    
    // Helper to handle backpressure properly
    const writeWithBackpressure = (chunk) => {
      return new Promise((resolveWrite) => {
        if (!writeStream.write(chunk)) {
          writeStream.once('drain', resolveWrite);
        } else {
          resolveWrite();
        }
      });
    };
    
    // Handle objects with specific structure (buildings_index, demand_data)
    if (data && typeof data === 'object') {
      (async () => {
        try {
          await writeWithBackpressure('{');
          const keys = Object.keys(data);
          
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (i > 0) await writeWithBackpressure(',');
            
            await writeWithBackpressure(`"${key}":`);
            
            // If value is an array, stream it element by element
            if (Array.isArray(data[key])) {
              await writeWithBackpressure('[');
              
              for (let j = 0; j < data[key].length; j++) {
                if (j > 0) await writeWithBackpressure(',');
                await writeWithBackpressure(JSON.stringify(data[key][j]));
                
                if (progressCallback && j % 5000 === 0 && data[key].length > 10000) {
                  progressCallback(key, j, data[key].length);
                }
              }
              
              await writeWithBackpressure(']');
              if (progressCallback && data[key].length > 10000) {
                progressCallback(key, data[key].length, data[key].length);
              }
            } else {
              // For non-array values, stringify normally
              await writeWithBackpressure(JSON.stringify(data[key]));
            }
          }
          
          writeStream.end('}');
        } catch (err) {
          reject(err);
        }
      })();
    } else {
      // Fallback for simple data
      try {
        writeStream.end(JSON.stringify(data));
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
    console.log('  Reading raw data (MessagePack binary, in parallel)...');
    const startRead = Date.now();
    
    // Read buildings and places in parallel (Option 1)
    const [rawBuildings, rawPlaces] = await Promise.all([
      readMsgpackBinary(`./raw_data/${place.code}/buildings.msgpack`),
      readMsgpackBinary(`./raw_data/${place.code}/places.msgpack`)
    ]);
    
    const readTime = ((Date.now() - startRead) / 1000).toFixed(1);
    console.log(`  ✓ Read ${rawBuildings.length.toLocaleString()} buildings + ${rawPlaces.length.toLocaleString()} places in ${readTime}s`);

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
