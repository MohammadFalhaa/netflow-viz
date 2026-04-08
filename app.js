// ── STATE ───────────────────────────────────────────────────────────────────
const state = { flowData: null, memberData: null }
const ui    = {
  simulation:     null,
  nodes:          [],
  allEdges:       [],       // all inter-community edges (pre-filter)
  edgeSel:        null,     // current D3 selection of visible edge paths
  nodeGroups:     null,
  communityMeta:  null,
  scales:         null,
  zoomBehavior:   null,
  svg:            null,
  zoomGroup:      null,
  selectedNodes:   [],
  selectedEdge:    null,
  dirFilter:       'all',     // 'all' | 'out' (red) | 'in' (blue)
  thresholdVal:    0,
  topCommunities:  Infinity,  // show top-N communities by flow volume
  topSingle:       CFG.handles.defaultSingle,
  topCompare:      CFG.handles.defaultCompare,
  pathKeys:        null,
  applyFilters:    null,      // set by setupThresholdSlider, called by community slider
}

const fmt = d3.format(',')

// Sync input constraints from config
document.getElementById('top-single-input').max  = CFG.handles.max
document.getElementById('top-compare-input').max = CFG.handles.max

// ── LOADING ─────────────────────────────────────────────────────────────────
// ── CSV PARSERS ──────────────────────────────────────────────────────────────
function parseFlowCSV(text) {
  return d3.csvParse(text, row => ({
    source: +row.source_community,
    target: +row.target_community,
    count:  +row.edge_count,
  })).filter(d => !isNaN(d.source) && !isNaN(d.target) && d.count > 0)
}

function parseMembersCSV(text) {
  return d3.csvParse(text, row => ({
    username:    row.username     || '',
    displayName: row.display_name || '',
    pagerank:    +row.pagerank,
    inDegree:    +row.in_degree,
    outDegree:   +row.out_degree,
    communityId: +row.community_id,
  })).filter(d => !isNaN(d.communityId))
}

function saveLS(key, text, name) {
  try { localStorage.setItem('nv_' + key, text); localStorage.setItem('nv_' + key + '_name', name) }
  catch(e) { /* quota exceeded — silent */ }
}
function removeLS(key) {
  localStorage.removeItem('nv_' + key); localStorage.removeItem('nv_' + key + '_name')
}

document.getElementById('flow-input').addEventListener('change', e => {
  const file = e.target.files[0]
  if (!file) return
  if (file.size > 10 * 1024 * 1024) {
    alert(`Flow CSV is ${(file.size/1024/1024).toFixed(1)} MB — this may be too large to render smoothly. Consider filtering to fewer communities first.`)
    e.target.value = ''; return
  }
  readFile(file, text => {
    const parsed = parseFlowCSV(text)
    const nodeCount = new Set(parsed.flatMap(d => [d.source, d.target])).size
    if (nodeCount > 300) {
      if (!confirm(`This CSV has ${nodeCount} communities — large graphs may be slow. Continue?`)) {
        e.target.value = ''; return
      }
    }
    state.flowData = parsed
    saveLS('flow', text, file.name)
    markLoaded('flow-label', 'flow-dot', 'flow-clear', `${file.name} (${nodeCount} communities)`)
    e.target.value = ''
    tryRender()
  })
})

document.getElementById('members-input').addEventListener('change', e => {
  const file = e.target.files[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    if (!confirm(`Members CSV is ${(file.size/1024/1024).toFixed(1)} MB — only top 10 per community will be shown. Continue?`)) {
      e.target.value = ''; return
    }
  }
  readFile(file, text => {
    state.memberData = parseMembersCSV(text)
    const comCount = new Set(state.memberData.map(m => m.communityId)).size
    const label = `${file.name} (${comCount} communities, ${fmt(state.memberData.length)} rows)`
    saveLS('members', text, label)
    markLoaded('members-label', 'members-dot', 'members-clear', label)
    e.target.value = ''
    tryRender()
  })
})

document.getElementById('flow-clear').onclick = () => {
  state.flowData = null
  removeLS('flow')
  clearFileBtn('flow-label', 'flow-dot', 'flow-clear', 'Upload Flow CSV')
  document.getElementById('flow-input').value = ''
  resetToBlank()
}

document.getElementById('members-clear').onclick = () => {
  state.memberData = null
  removeLS('members')
  clearFileBtn('members-label', 'members-dot', 'members-clear', 'Upload Members CSV')
  document.getElementById('members-input').value = ''
  if (state.flowData) tryRender()
}

function resetToBlank() {
  // Stop simulation and wipe the SVG
  if (ui.simulation) { ui.simulation.stop(); ui.simulation = null }
  ui.nodes = []; ui.allEdges = []; ui.edgeSel = null; ui.nodeGroups = null
  ui.selectedNodes = []; ui.selectedEdge = null; ui.pathKeys = null
  d3.select('#graph-svg').selectAll('*').remove()
  closePanel(); resetSelection()
  document.getElementById('empty-state').style.display = ''
  document.getElementById('legend').style.display = 'none'
  document.getElementById('edge-count-label').textContent = '—'
  document.getElementById('community-count-label').textContent = '— / —'
}

function readFile(file, cb) {
  const r = new FileReader()
  r.onload = ev => cb(ev.target.result)
  r.readAsText(file)
}

function markLoaded(labelId, dotId, clearId, filename) {
  const lbl = document.getElementById(labelId)
  lbl.classList.add('loaded')
  const shortName = filename.length > 24 ? filename.slice(0, 22) + '…' : filename
  lbl.innerHTML = `<span class="status-dot loaded"></span>${shortName}`
  document.getElementById(clearId).style.display = 'inline-block'
}

function clearFileBtn(labelId, dotId, clearId, defaultText) {
  const lbl = document.getElementById(labelId)
  lbl.classList.remove('loaded')
  lbl.innerHTML = `<span class="status-dot" id="${dotId}"></span>${defaultText}`
  document.getElementById(clearId).style.display = 'none'
}

function tryRender() {
  if (state.flowData) {
    document.getElementById('empty-state').style.display = 'none'
    document.getElementById('legend').style.display = 'block'
    initVisualization(state.flowData, state.memberData || [])
  }
}

// ── DATA PROCESSING ──────────────────────────────────────────────────────────
function preprocessData(flowRows, memberRows) {
  const selfLoops  = flowRows.filter(d => d.source === d.target)
  const interEdges = flowRows.filter(d => d.source !== d.target)

  // Unique community IDs from flow data
  const communityIds = [...new Set(flowRows.flatMap(d => [d.source, d.target]))].sort((a,b) => a-b)

  // Detect bidirectional pairs → assign curvature and color role
  const pairMap = new Map()
  interEdges.forEach(e => {
    const key = `${Math.min(e.source, e.target)}_${Math.max(e.source, e.target)}`
    if (!pairMap.has(key)) pairMap.set(key, [])
    pairMap.get(key).push(e)
  })
  interEdges.forEach(e => {
    const key = `${Math.min(e.source, e.target)}_${Math.max(e.source, e.target)}`
    const pair = pairMap.get(key)
    // Color rule: canonical lower-ID→higher-ID = red, reverse = blue.
    // This applies to ALL edges (bidirectional or single) so color = direction.
    const isCanonical = e.source < e.target
    e.edgeColor = isCanonical ? CFG.edge.outColor : CFG.edge.inColor
    e.arrowId   = isCanonical ? 'arr-out' : 'arr-in'
    if (pair.length === 2) {
      e.curvature = pair[0] === e ? 1 : -1
    } else {
      e.curvature = 0.25
    }
  })

  // Community metadata
  const communityMeta = new Map()
  communityIds.forEach(id => {
    const members = memberRows
      .filter(m => m.communityId === id)
      .sort((a, b) => b.pagerank - a.pagerank)
      .slice(0, 10)
    const selfLoop = selfLoops.find(s => s.source === id) || null
    const outEdges = interEdges.filter(e => e.source === id)
    const inEdges  = interEdges.filter(e => e.target === id)
    const totalOut = outEdges.reduce((s, e) => s + e.count, 0)
    const totalIn  = inEdges.reduce((s, e)  => s + e.count, 0)
    const neighbors = new Set([...outEdges.map(e => e.target), ...inEdges.map(e => e.source)])
    communityMeta.set(id, { id, members, selfLoop, totalOut, totalIn, degree: neighbors.size })
  })

  // Scales
  const countExtent = d3.extent(interEdges, d => d.count)
  const edgeWidthScale = d3.scaleLog()
    .domain([Math.max(1, countExtent[0] || 1), Math.max(2, countExtent[1] || 2)])
    .range([CFG.edge.minWidth, CFG.edge.maxWidth])
    .clamp(true)

  const volumes = [...communityMeta.values()].map(m => m.totalOut + m.totalIn)
  const volExtent = d3.extent(volumes)
  const nodeSizeScale = d3.scaleSqrt()
    .domain([volExtent[0] || 0, Math.max(volExtent[1] || 1, 1)])
    .range([CFG.node.minR, CFG.node.maxR])

  const colorScale = d3.scaleSequential(d3.interpolateRainbow).domain([0, communityIds.length])
  const colorMap   = new Map(communityIds.map((id, i) => [id, colorScale(i)]))

  // Rank communities by total volume (rank 1 = highest flow)
  const sortedByVol = [...communityMeta.values()]
    .sort((a, b) => (b.totalOut + b.totalIn) - (a.totalOut + a.totalIn))
  sortedByVol.forEach((m, i) => { m.rank = i + 1 })

  return { selfLoops, interEdges, communityIds, communityMeta, edgeWidthScale, nodeSizeScale, colorMap }
}

// ── SVG SETUP ────────────────────────────────────────────────────────────────
function setupSVG(svg) {
  svg.selectAll('*').remove()

  const defs = svg.append('defs')
  const arrowDefs = [
    { id: 'arr-out',    fill: '#e74c3c' },
    { id: 'arr-in',     fill: '#3498db' },
    { id: 'arr-path',   fill: '#f5a623' },  // strongest path highlight
    { id: 'arr-default',fill: '#667180' },  // fallback for reset state
  ]
  const AL = CFG.edge.arrowLen
  arrowDefs.forEach(({ id, fill }) => {
    defs.append('marker')
      .attr('id', id)
      .attr('markerWidth', AL + 2)
      .attr('markerHeight', AL * 0.7)
      .attr('refX', 0)          // base of arrow at path endpoint; tip points forward
      .attr('refY', AL * 0.35)
      .attr('orient', 'auto')
      .attr('markerUnits', 'userSpaceOnUse')
      .append('path')
        .attr('d', `M0,0 L${AL},${AL * 0.35} L0,${AL * 0.7} Z`)
        .attr('fill', fill)
  })

  const zoomGroup = svg.append('g').attr('id', 'zoom-group')
  zoomGroup.append('g').attr('class', 'edges-layer')
  zoomGroup.append('g').attr('class', 'nodes-layer')

  return zoomGroup
}

// ── MAIN INIT ────────────────────────────────────────────────────────────────
function initVisualization(flowData, memberData) {
  if (ui.simulation) ui.simulation.stop()
  closePanel()
  resetSelection()

  const container = document.getElementById('graph-container')
  const W = container.clientWidth
  const H = container.clientHeight

  const svg = d3.select('#graph-svg')
  const zoomGroup = setupSVG(svg)
  ui.svg = svg; ui.zoomGroup = zoomGroup

  const { selfLoops, interEdges, communityIds, communityMeta,
          edgeWidthScale, nodeSizeScale, colorMap } = preprocessData(flowData, memberData)

  ui.communityMeta = communityMeta
  ui.scales = { edgeWidthScale, colorMap, edgeWidthScale }
  ui.allEdges = interEdges

  // Node objects (D3 force will add x, y, vx, vy)
  const nodes = communityIds.map(id => {
    const meta = communityMeta.get(id)
    return { id, r: nodeSizeScale(meta.totalOut + meta.totalIn), color: colorMap.get(id), meta }
  })
  ui.nodes = nodes

  // Edge objects for simulation
  const simLinks = interEdges.map(e => ({ ...e }))

  // Zoom/pan
  const zoom = d3.zoom().scaleExtent([0.04, 10]).on('zoom', ev => {
    zoomGroup.attr('transform', ev.transform)
  })
  svg.call(zoom)
  ui.zoomBehavior = zoom

  document.getElementById('reset-btn').onclick = () => {
    const ns = ui.nodes
    if (!ns || ns.length === 0) {
      svg.transition().duration(480).call(zoom.transform, d3.zoomIdentity)
      return
    }
    // Restore every node to its original post-warmup position
    ns.forEach(n => { n.x = n.fx = n.ox; n.y = n.fy = n.oy })
    ticked()  // redraw edges immediately at restored positions

    // Fit the restored bounding box into the viewport
    const pad = 60
    const minX = d3.min(ns, n => n.ox - n.r) - pad
    const maxX = d3.max(ns, n => n.ox + n.r) + pad
    const minY = d3.min(ns, n => n.oy - n.r) - pad
    const maxY = d3.max(ns, n => n.oy + n.r) + pad
    const cW = container.clientWidth, cH = container.clientHeight
    const scale = Math.max(0.35, Math.min(cW / (maxX - minX), cH / (maxY - minY), 1.8))
    const tx = cW / 2 - scale * (minX + maxX) / 2
    const ty = cH / 2 - scale * (minY + maxY) / 2
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale))
  }

  // Background click → deselect all
  svg.on('click', ev => {
    if (ev.target === svg.node()) { resetSelection(); closePanel() }
  })

  // Render edges
  renderEdges(simLinks, zoomGroup, edgeWidthScale)

  // Render nodes
  renderNodes(nodes, zoomGroup)

  // Build + warm-up simulation
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(simLinks).id(d => d.id)
      .distance(CFG.sim.linkDist).strength(CFG.sim.linkStrength))
    .force('charge', d3.forceManyBody().strength(CFG.sim.charge))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide(d => d.r + CFG.sim.collide))
    .stop()

  for (let i = 0; i < CFG.sim.warmupTicks; i++) sim.tick()

  // Pin every node at its settled position; also store as origin for reset
  nodes.forEach(n => { n.fx = n.x; n.fy = n.y; n.ox = n.x; n.oy = n.y })

  ticked()   // first render
  sim.on('tick', ticked)
  ui.simulation = sim

  setupThresholdSlider(interEdges, nodes)
}

// Wire top-handles inputs (outside initVisualization so they persist across re-renders)
document.getElementById('top-single-input').addEventListener('change', ev => {
  ui.topSingle = Math.min(CFG.handles.max, Math.max(1, +ev.target.value || CFG.handles.defaultSingle))
  ev.target.value = ui.topSingle
  if (ui.selectedNodes.length === 1) openPanel(ui.selectedNodes)
})
document.getElementById('top-compare-input').addEventListener('change', ev => {
  ui.topCompare = Math.min(CFG.handles.max, Math.max(1, +ev.target.value || CFG.handles.defaultCompare))
  ev.target.value = ui.topCompare
  if (ui.selectedNodes.length === 2) openPanel(ui.selectedNodes)
})

// ── RENDER EDGES ─────────────────────────────────────────────────────────────
function renderEdges(edges, zoomGroup, edgeWidthScale) {
  const layer = zoomGroup.select('.edges-layer')

  const sel = layer.selectAll('.edge-path')
    .data(edges, d => `${d.source}->${d.target}`)
    .join('path')
      .attr('class', 'edge-path')
      .attr('stroke', d => d.edgeColor)
      .attr('stroke-opacity', 0.65)
      .attr('stroke-width', d => edgeWidthScale(d.count))
      .attr('marker-end', d => `url(#${d.arrowId})`)
      .on('mouseover', onEdgeHover)
      .on('mouseout',  onEdgeHoverOut)
      .on('click',     (ev, d) => { ev.stopPropagation(); onEdgeClick(ev, d) })

  ui.edgeSel = sel
}

// ── RENDER NODES ─────────────────────────────────────────────────────────────
function renderNodes(nodes, zoomGroup) {
  const layer = zoomGroup.select('.nodes-layer')

  const drag = d3.drag()
    .on('start', (ev, d) => {
      // All other nodes remain pinned; only this node is dragged
      d.fx = d.x; d.fy = d.y
    })
    .on('drag', (ev, d) => {
      d.x = d.fx = ev.x
      d.y = d.fy = ev.y
      ticked()  // update paths without restarting physics
    })
    .on('end', (ev, d) => {
      d.fx = d.x; d.fy = d.y  // stay pinned at dropped position
    })

  const gs = layer.selectAll('.node-g')
    .data(nodes, d => d.id)
    .join('g')
      .attr('class', 'node-g')
      .call(drag)
      .on('click',     (ev, d) => { ev.stopPropagation(); onNodeClick(ev, d) })
      .on('mouseover', onNodeHover)
      .on('mouseout',  onNodeHoverOut)

  gs.append('circle')
    .attr('class', 'node-circle')
    .attr('r', d => d.r)
    .attr('fill', d => d.color)
    .attr('stroke', CFG.node.stroke)
    .attr('stroke-width', CFG.node.strokeW)

  gs.append('text')
    .attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .attr('font-size', d => Math.max(7, Math.min(d.r * 0.52, 13)))
    .text(d => `C${d.id}`)

  ui.nodeGroups = gs
}

// ── TICK ─────────────────────────────────────────────────────────────────────
function ticked() {
  if (!ui.edgeSel || !ui.nodeGroups) return

  ui.edgeSel.attr('d', d => edgePath(d))
  ui.nodeGroups.attr('transform', d => `translate(${d.x},${d.y})`)
}

// ── EDGE PATH ────────────────────────────────────────────────────────────────
function edgePath(d) {
  const s = (typeof d.source === 'object') ? d.source : ui.nodes.find(n => n.id === d.source)
  const t = (typeof d.target === 'object') ? d.target : ui.nodes.find(n => n.id === d.target)
  if (!s || !t) return ''

  const sx = s.x, sy = s.y, sr = s.r
  const tx = t.x, ty = t.y, tr = t.r
  const dx = tx - sx, dy = ty - sy
  const len = Math.sqrt(dx*dx + dy*dy)
  if (len < 1) return ''

  const ux = dx/len, uy = dy/len
  const AL = CFG.edge.arrowLen

  // Source start: at circle boundary
  const asx = sx + ux * sr
  const asy = sy + uy * sr

  if (Math.abs(d.curvature) < 0.01) {
    // Path ends at arrow base (tr + AL before center); arrow tip sits exactly at node boundary
    const atx = tx - ux * (tr + AL)
    const aty = ty - uy * (tr + AL)
    return `M${asx},${asy} L${atx},${aty}`
  }

  // Canonical perpendicular (lower-ID → higher-ID axis) so bidirectional pairs curve opposite sides
  const canonSign = s.id < t.id ? 1 : -1
  const cpx = -uy * canonSign
  const cpy =  ux * canonSign
  const offsetMag = Math.max(CFG.edge.curvOffset, len * 0.28)

  // Step 1: rough endpoint at node boundary to get control point
  const atxR = tx - ux * tr
  const atyR = ty - uy * tr
  const cx = (asx + atxR) / 2 + cpx * offsetMag * d.curvature
  const cy = (asy + atyR) / 2 + cpy * offsetMag * d.curvature

  // Step 2: real tangent at endpoint = direction from control point to rough endpoint
  const tdx = atxR - cx, tdy = atyR - cy
  const tl   = Math.sqrt(tdx*tdx + tdy*tdy)
  const tux  = tl > 0 ? tdx/tl : ux
  const tuy  = tl > 0 ? tdy/tl : uy

  // Step 3: refined endpoint — at arrow base (tr + AL before center along tangent)
  // With refX=0 the arrow tip extends forward by AL, landing exactly at node boundary
  const atx = tx - tux * (tr + AL)
  const aty = ty - tuy * (tr + AL)

  return `M${asx},${asy} Q${cx},${cy} ${atx},${aty}`
}

// ── INTERACTIONS ─────────────────────────────────────────────────────────────
function onEdgeHover(ev, d) {
  if (ui.selectedEdge || ui.selectedNodes.length) return
  const s = d.source, t = d.target
  const sId = typeof s === 'object' ? s.id : s
  const tId = typeof t === 'object' ? t.id : t
  showTip(ev, `
    <div class="tt-head">C${sId} → C${tId}</div>
    <div class="tt-flow">${fmt(d.count)}</div>
    <div>interactions</div>
  `)
  d3.select(ev.currentTarget).raise()
    .attr('stroke-opacity', 1)
    .attr('stroke-width', ui.scales.edgeWidthScale(d.count) + 1.5)
}

function onEdgeHoverOut(ev, d) {
  if (ui.selectedEdge || ui.selectedNodes.length) return
  hideTip()
  d3.select(ev.currentTarget)
    .attr('stroke-opacity', 0.65)
    .attr('stroke-width', ui.scales.edgeWidthScale(d.count))
}

function onEdgeClick(ev, d) {
  if (ui.selectedEdge === d) { resetSelection(); return }
  resetSelection()
  ui.selectedEdge = d

  const sId = typeof d.source === 'object' ? d.source.id : d.source
  const tId = typeof d.target === 'object' ? d.target.id : d.target

  ui.edgeSel
    .classed('dim', e => e !== d)
    .classed('hi-out', e => e === d)
    .attr('stroke', e => e === d ? CFG.edge.outColor : e.edgeColor)
    .attr('stroke-opacity', e => e === d ? 1 : 0.65)
    .attr('marker-end', e => e === d ? 'url(#arr-out)' : `url(#${e.arrowId})`)

  // Highlight source/target nodes
  ui.nodeGroups.select('circle')
    .classed('dim', nd => nd.id !== sId && nd.id !== tId)
    .classed('hi',  nd => nd.id === sId || nd.id === tId)

  showTip(ev, `
    <div class="tt-head">C${sId} → C${tId}</div>
    <div class="tt-flow">${fmt(d.count)}</div>
    <div>interactions</div>
    <div class="tt-hint">Click again to clear</div>
  `, true)
}

function onNodeHover(ev, d) {
  if (ui.selectedNodes.length || ui.selectedEdge) return
  const m = d.meta
  showTip(ev, `
    <div class="tt-head">Community C${d.id}</div>
    <div class="tt-out">Out-flow: ${fmt(m.totalOut)}</div>
    <div class="tt-in">In-flow: ${fmt(m.totalIn)}</div>
    <div style="color:#555;font-size:10px;margin-top:3px">${m.degree} connections · click · shift+click to compare</div>
  `)
}

function onNodeHoverOut(ev, d) {
  if (ui.selectedNodes.length || ui.selectedEdge) return
  hideTip()
}

function onNodeClick(ev, d) {
  const alreadyIdx = ui.selectedNodes.findIndex(n => n.id === d.id)

  if (ev.shiftKey) {
    // Shift+click: toggle this node in/out of multi-selection (max 2)
    if (alreadyIdx >= 0) {
      ui.selectedNodes.splice(alreadyIdx, 1)
    } else if (ui.selectedNodes.length < 2) {
      ui.selectedNodes.push(d)
    } else {
      // Replace the oldest selection with this one
      ui.selectedNodes[0] = ui.selectedNodes[1]
      ui.selectedNodes[1] = d
    }
  } else {
    // Regular click: if this node is the only selection, deselect; else select only this
    if (ui.selectedNodes.length === 1 && alreadyIdx === 0) {
      ui.selectedNodes = []
    } else {
      ui.selectedNodes = [d]
    }
  }

  hideTip()

  if (ui.selectedNodes.length === 0) {
    resetSelection(); closePanel(); return
  }

  // Apply edge highlighting
  applyNodeHighlight()
  openPanel(ui.selectedNodes)
}

function applyNodeHighlight() {
  const sel = ui.selectedNodes
  if (!sel.length) return

  const ids = sel.map(n => n.id)

  ui.edgeSel.each(function(e) {
    const sId = typeof e.source === 'object' ? e.source.id : e.source
    const tId = typeof e.target === 'object' ? e.target.id : e.target

    const isOut  = ids.includes(sId)
    const isIn   = ids.includes(tId)
    const isRel  = isOut || isIn

    // Direct edge between the two selected communities
    const isDirect = sel.length === 2 && ids.includes(sId) && ids.includes(tId)

    let stroke, marker
    if (isDirect)     { stroke = '#f5a623'; marker = 'url(#arr-out)' }
    else if (isOut)   { stroke = CFG.edge.outColor; marker = 'url(#arr-out)' }
    else if (isIn)    { stroke = CFG.edge.inColor;  marker = 'url(#arr-in)'  }
    else              { stroke = e.edgeColor; marker = `url(#${e.arrowId})` }

    d3.select(this)
      .classed('dim',    !isRel)
      .classed('hi-out',  isOut && !isDirect)
      .classed('hi-in',   isIn  && !isDirect)
      .attr('stroke', stroke)
      .attr('stroke-opacity', isRel ? 1 : 0.65)
      .attr('marker-end', marker)
  })

  const connected = new Set(ids)
  ui.edgeSel.each(e => {
    const sId = typeof e.source === 'object' ? e.source.id : e.source
    const tId = typeof e.target === 'object' ? e.target.id : e.target
    if (ids.includes(sId)) connected.add(tId)
    if (ids.includes(tId)) connected.add(sId)
  })
  ui.nodeGroups.select('circle')
    .classed('dim', nd => !connected.has(nd.id))
    .classed('hi',  nd => ids.includes(nd.id))
}

function resetSelection() {
  ui.selectedNodes = []
  ui.selectedEdge  = null
  ui.pathKeys      = null

  if (ui.edgeSel) {
    ui.edgeSel
      .classed('dim hi-out hi-in', false)
      .attr('stroke', d => d.edgeColor)
      .attr('stroke-opacity', 0.65)
      .attr('marker-end', d => `url(#${d.arrowId})`)
  }
  if (ui.nodeGroups) {
    ui.nodeGroups.select('circle').classed('dim hi', false)
  }
  hideTip(true)
}

// ── SIDE PANEL ───────────────────────────────────────────────────────────────
function openPanel(nodes) {
  // nodes is always an array (1 or 2 elements)
  if (!Array.isArray(nodes)) nodes = [nodes]

  const panel = document.getElementById('side-panel')

  if (nodes.length === 1) {
    renderSinglePanel(nodes[0])
  } else {
    renderComparePanel(nodes[0], nodes[1])
  }

  panel.classList.add('open')
}

function renderSinglePanel(nodeData) {
  const meta = nodeData.meta

  // Reset dot to single circle
  const dot = document.getElementById('panel-color-dot')
  dot.style.cssText = 'width:11px;height:11px;border-radius:50%;flex-shrink:0'
  dot.style.background = nodeData.color
  dot.innerHTML = ''
  document.getElementById('panel-title').textContent = `Community C${nodeData.id}`

  document.getElementById('panel-stats').innerHTML = `
    <div class="stat-row"><span class="stat-key">Outgoing flow</span><span class="stat-val out">${fmt(meta.totalOut)}</span></div>
    <div class="stat-row"><span class="stat-key">Incoming flow</span><span class="stat-val in">${fmt(meta.totalIn)}</span></div>
    <div class="stat-row"><span class="stat-key">Internal activity</span><span class="stat-val">${meta.selfLoop ? fmt(meta.selfLoop.count) : '—'}</span></div>
    <div class="stat-row"><span class="stat-key">Connections</span><span class="stat-val">${meta.degree}</span></div>
    <div class="panel-hint">Shift+click another community to compare</div>
  `

  document.getElementById('panel-members-section').innerHTML = `
    <h3>Top ${ui.topSingle} Handles</h3>
    <div id="panel-members">${membersHTML(meta.members, ui.topSingle)}</div>
  `
}

function renderComparePanel(a, b) {
  // Header: two colored dots side by side (not stuffed inside a tiny circle)
  const dot = document.getElementById('panel-color-dot')
  dot.style.cssText = 'display:flex;gap:4px;align-items:center;flex-shrink:0'
  dot.style.background = 'transparent'
  dot.innerHTML = `<div class="panel-cdot" style="background:${a.color}"></div><div class="panel-cdot" style="background:${b.color}"></div>`
  document.getElementById('panel-title').textContent = `C${a.id} vs C${b.id}`

  // Direct flow between the two
  const ab = ui.allEdges.find(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source
    const t = typeof e.target === 'object' ? e.target.id : e.target
    return s === a.id && t === b.id
  })
  const ba = ui.allEdges.find(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source
    const t = typeof e.target === 'object' ? e.target.id : e.target
    return s === b.id && t === a.id
  })

  const directHTML = (ab || ba) ? `
    <div class="compare-direct">
      <strong>Direct flow</strong>
      ${ab ? `<div class="direct-row"><span class="direct-out">C${a.id} → C${b.id}</span><span class="direct-count">${fmt(ab.count)}</span></div>` : ''}
      ${ba ? `<div class="direct-row"><span class="direct-in">C${b.id} → C${a.id}</span><span class="direct-count">${fmt(ba.count)}</span></div>` : ''}
    </div>` : ''

  document.getElementById('panel-stats').innerHTML = directHTML + `
    <div style="padding:9px 15px 10px;border-bottom:1px solid #252839;flex-shrink:0">
      <button id="path-btn" style="
        width:100%;padding:6px;background:#1e2236;border:1px solid #3d4162;
        border-radius:5px;font-size:12px;color:#a0aec0;cursor:pointer;
        transition:background 0.15s,color 0.15s
      " onmouseover="this.style.background='#252839';this.style.color='#f5a623'"
         onmouseout="this.style.background='#1e2236';this.style.color='#a0aec0'">
        Find Strongest Path
      </button>
      <div style="margin-top:6px;font-size:10px;color:#3d4162;line-height:1.5">
        Finds the route with the strongest bottleneck — maximizes the weakest edge along the path.
        May use intermediaries if the direct edge is weaker than an indirect route.
      </div>
      <div id="path-result" style="margin-top:7px;font-size:11px;color:#888;line-height:1.6"></div>
    </div>`

  // Attach path button handler after DOM update
  setTimeout(() => {
    const btn = document.getElementById('path-btn')
    if (btn) btn.addEventListener('click', () => runStrongestPath(a, b))
  }, 0)

  document.getElementById('panel-members-section').innerHTML = `
    <div style="flex:1;overflow-y:auto;padding-bottom:8px">
      <div class="compare-section-hd">
        <div class="panel-cdot" style="background:${a.color}"></div>Community C${a.id}
        <span style="font-size:10px;color:#444;margin-left:auto">top ${ui.topCompare}</span>
      </div>
      <div class="compare-stats">
        <div class="stat-row"><span class="stat-key">Out</span><span class="stat-val out">${fmt(a.meta.totalOut)}</span></div>
        <div class="stat-row"><span class="stat-key">In</span><span class="stat-val in">${fmt(a.meta.totalIn)}</span></div>
        <div class="stat-row"><span class="stat-key">Connections</span><span class="stat-val">${a.meta.degree}</span></div>
      </div>
      <div style="padding:0 8px 6px">${membersHTML(a.meta.members, ui.topCompare)}</div>
      <div class="compare-divider"></div>
      <div class="compare-section-hd">
        <div class="panel-cdot" style="background:${b.color}"></div>Community C${b.id}
      </div>
      <div class="compare-stats">
        <div class="stat-row"><span class="stat-key">Out</span><span class="stat-val out">${fmt(b.meta.totalOut)}</span></div>
        <div class="stat-row"><span class="stat-key">In</span><span class="stat-val in">${fmt(b.meta.totalIn)}</span></div>
        <div class="stat-row"><span class="stat-key">Connections</span><span class="stat-val">${b.meta.degree}</span></div>
      </div>
      <div style="padding:0 8px 6px">${membersHTML(b.meta.members, ui.topCompare)}</div>
    </div>
  `
}

// ── STRONGEST PATH ───────────────────────────────────────────────────────────
function findStrongestPath(fromId, toId) {
  // Widest-path Dijkstra: maximize the minimum edge count along the path
  // (= the "bottleneck" capacity of the best route)
  const adj = new Map()
  ui.allEdges.forEach(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source
    const t = typeof e.target === 'object' ? e.target.id : e.target
    if (!adj.has(s)) adj.set(s, [])
    adj.get(s).push({ to: t, count: e.count, edge: e })
  })

  const best = new Map()   // nodeId → max bottleneck to reach it
  const prev = new Map()   // nodeId → { from, edge }
  ui.nodes.forEach(n => best.set(n.id, 0))
  best.set(fromId, Infinity)

  const visited = new Set()
  while (true) {
    let u = null, uBest = -1
    best.forEach((val, id) => {
      if (!visited.has(id) && val > uBest) { u = id; uBest = val }
    })
    if (u === null || uBest === 0) break
    if (u === toId) break
    visited.add(u)
    ;(adj.get(u) || []).forEach(({ to, count, edge }) => {
      if (visited.has(to)) return
      const nb = Math.min(uBest, count)
      if (nb > (best.get(to) || 0)) {
        best.set(to, nb)
        prev.set(to, { from: u, edge })
      }
    })
  }

  if (!prev.has(toId)) return null  // no path
  const pathKeys = new Set(), pathNodes = [toId]
  let cur = toId
  while (cur !== fromId) {
    const p = prev.get(cur)
    if (!p) return null
    // Store as "srcId->tgtId" key (matches simLinks by id, not object ref)
    const es = typeof p.edge.source === 'object' ? p.edge.source.id : p.edge.source
    const et = typeof p.edge.target === 'object' ? p.edge.target.id : p.edge.target
    pathKeys.add(`${es}->${et}`)
    pathNodes.unshift(p.from)
    cur = p.from
  }
  return { pathKeys, pathNodes, bottleneck: best.get(toId) || 0, hops: pathNodes.length - 1 }
}

function edgeKey(e) {
  const s = typeof e.source === 'object' ? e.source.id : e.source
  const t = typeof e.target === 'object' ? e.target.id : e.target
  return `${s}->${t}`
}

function runStrongestPath(a, b) {
  const result = findStrongestPath(a.id, b.id)
  const el = document.getElementById('path-result')
  if (!result || result.hops === 0) {
    if (el) el.innerHTML = '<span style="color:#e74c3c">No path found between these communities.</span>'
    return
  }

  // Look up the direct edge (if any) to compare against the found path
  const directEdge = ui.allEdges.find(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source
    const t = typeof e.target === 'object' ? e.target.id : e.target
    return s === a.id && t === b.id
  })
  const directFlow = directEdge ? directEdge.count : null

  const pathStr    = result.pathNodes.map(id => `C${id}`).join(' → ')
  const isIndirect = result.hops > 1

  // When indirect despite a direct edge existing, show why the indirect route won
  let whyNote = ''
  if (isIndirect && directFlow !== null) {
    if (result.bottleneck > directFlow) {
      whyNote = `<div style="color:#888;font-size:10px;margin-top:4px;line-height:1.5">
        Direct edge flow: <strong style="color:#aaa">${fmt(directFlow)}</strong> —
        the indirect route's weakest link (<strong style="color:#f5a623">${fmt(result.bottleneck)}</strong>)
        is stronger, so this path has better overall capacity.
      </div>`
    } else {
      whyNote = `<div style="color:#666;font-size:10px;margin-top:4px;line-height:1.5">
        Note: direct flow is ${fmt(directFlow)}, but this is the widest bottleneck route.
      </div>`
    }
  }

  if (el) el.innerHTML = `
    <div style="color:#f5a623;font-weight:600;word-break:break-word">${pathStr}</div>
    <div style="margin-top:3px">
      Min flow along path: <strong style="color:#f5a623">${fmt(result.bottleneck)}</strong>
      <span style="color:#555;font-size:10px;margin-left:6px">${result.hops} hop${result.hops !== 1 ? 's' : ''}</span>
    </div>
    ${whyNote}
  `

  // Store as Set of string keys — matches simLinks regardless of object identity
  ui.pathKeys = result.pathKeys
  const pathNodeIds = new Set(result.pathNodes)

  if (ui.edgeSel) {
    ui.edgeSel.each(function(e) {
      const inPath = ui.pathKeys.has(edgeKey(e))
      const sel = d3.select(this)
      // Must clear hi-out / hi-in — they carry `stroke: color !important` in CSS
      // which would override the inline stroke we set below
      sel.classed('dim hi-out hi-in', false)
      if (inPath) {
        sel
          .style('display', null)           // force visible even if below threshold
          .style('pointer-events', null)
          .attr('stroke', '#f5a623')
          .attr('stroke-opacity', 1)
          .attr('stroke-width', Math.max(ui.scales.edgeWidthScale(e.count) + 2, 3))
          .attr('marker-end', 'url(#arr-path)')
      } else {
        sel
          .classed('dim', true)
          .attr('stroke', e.edgeColor)
          .attr('stroke-opacity', 0.05)
          .attr('stroke-width', ui.scales.edgeWidthScale(e.count))
          .attr('marker-end', `url(#${e.arrowId})`)
        // Do NOT touch display — respect threshold filter visibility
      }
    })
  }
  if (ui.nodeGroups) {
    ui.nodeGroups.select('circle')
      .classed('dim hi', false)
      .classed('dim', nd => !pathNodeIds.has(nd.id))
      .classed('hi',  nd => pathNodeIds.has(nd.id))
  }
}

function closePanel() {
  document.getElementById('side-panel').classList.remove('open')
}

function membersHTML(members, limit = 10) {
  if (!members || members.length === 0) {
    return '<div id="no-members">No handle data for this community.</div>'
  }
  return members.slice(0, limit).map((m, i) => `
    <div class="member-card">
      <div class="member-top">
        <span class="member-rank">${i + 1}</span>
        <a class="member-username" href="https://x.com/${m.username}" target="_blank" rel="noopener noreferrer">@${m.username}</a>
      </div>
      ${m.displayName ? `<div class="member-display">${m.displayName}</div>` : ''}
      <div class="member-metrics">
        <span class="member-metric">PR <span>${m.pagerank.toFixed(4)}</span></span>
        <span class="member-metric">In° <span>${fmt(m.inDegree)}</span></span>
        <span class="member-metric">Out° <span>${fmt(m.outDegree)}</span></span>
      </div>
    </div>
  `).join('')
}

document.getElementById('panel-close').onclick = () => { resetSelection(); closePanel() }

// ── TOOLTIP ──────────────────────────────────────────────────────────────────
let tipPinned = false

function showTip(ev, html, pin = false) {
  const el = document.getElementById('tooltip')
  el.innerHTML = html
  el.classList.add('show')
  tipPinned = pin
  moveTip(ev)
}

function moveTip(ev) {
  const el = document.getElementById('tooltip')
  const pad = 13
  let x = ev.clientX + pad, y = ev.clientY - pad
  el.style.left = x + 'px'; el.style.top = y + 'px'
  // Clamp to viewport
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect()
    if (r.right  > window.innerWidth)  el.style.left = (ev.clientX - r.width  - pad) + 'px'
    if (r.bottom > window.innerHeight) el.style.top  = (ev.clientY - r.height - pad) + 'px'
  })
}

function hideTip(force = false) {
  if (tipPinned && !force) return
  tipPinned = false
  document.getElementById('tooltip').classList.remove('show')
}

// ── FILTERS (threshold + direction + community count) ────────────────────────
function setupThresholdSlider(allEdges, allNodes) {
  const slider  = document.getElementById('threshold-slider')
  const label   = document.getElementById('edge-count-label')
  const commSl  = document.getElementById('community-slider')
  const commLbl = document.getElementById('community-count-label')
  const maxCnt  = d3.max(allEdges, d => d.count) || 1
  const total   = allNodes.length

  slider.value = 35

  // Init community slider range and default (show all)
  commSl.max = total
  commSl.value = total
  ui.topCommunities = total

  // Build a sorted list of [rank→minVolume] for the label
  // allNodes are already available; their meta.rank was set in preprocessData
  const volByRank = allNodes
    .slice()
    .sort((a, b) => a.meta.rank - b.meta.rank)
    .map(n => n.meta.totalOut + n.meta.totalIn)

  function updateCommLabel(n) {
    const minVol = volByRank[n - 1] || 0
    commLbl.textContent = `${n} / ${total}  (min activity: ${fmt(minVol)})`
  }
  updateCommLabel(total)

  function threshold(v) {
    if (+v === 0) return 0
    return Math.round(Math.pow(maxCnt, +v / 100))
  }

  function nodeVisible(id) {
    const meta = ui.communityMeta && ui.communityMeta.get(id)
    return meta ? meta.rank <= ui.topCommunities : true
  }

  function applyAll(thr) {
    ui.thresholdVal = thr
    if (!ui.edgeSel) return
    let vis = 0
    ui.edgeSel.each(function(d) {
      const sId = typeof d.source === 'object' ? d.source.id : d.source
      const tId = typeof d.target === 'object' ? d.target.id : d.target
      const show = d.count >= thr && edgeMatchesDir(d) && nodeVisible(sId) && nodeVisible(tId)
      if (show) vis++
      d3.select(this)
        .style('display',        show ? null : 'none')
        .style('pointer-events', show ? null : 'none')
    })
    // Show/hide node groups
    if (ui.nodeGroups) {
      ui.nodeGroups.style('display', d => nodeVisible(d.id) ? null : 'none')
    }
    label.textContent = `${fmt(vis)} / ${fmt(allEdges.length)} edges`
  }

  // Expose so community slider and other callers can trigger a full re-filter
  ui.applyFilters = () => applyAll(threshold(+slider.value))

  const debouncedApply = debounce(v => applyAll(threshold(v)), 28)
  slider.addEventListener('input', ev => debouncedApply(+ev.target.value))

  // Community count slider
  commSl.addEventListener('input', ev => {
    ui.topCommunities = +ev.target.value
    updateCommLabel(+ev.target.value)
    applyAll(threshold(+slider.value))
  })

  // Direction filter buttons
  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      ui.dirFilter = btn.dataset.dir
      applyAll(ui.thresholdVal)
    })
  })

  applyAll(threshold(35))
}

function edgeMatchesDir(d) {
  if (ui.dirFilter === 'all') return true
  const sId = typeof d.source === 'object' ? d.source.id : d.source
  const tId = typeof d.target === 'object' ? d.target.id : d.target
  if (ui.dirFilter === 'out') return sId < tId   // red: lower→higher
  if (ui.dirFilter === 'in')  return sId > tId   // blue: higher→lower
  return true
}

// ── EXPORT PNG ───────────────────────────────────────────────────────────────
document.getElementById('export-btn').addEventListener('click', () => {
  const svgEl  = document.getElementById('graph-svg')
  const W = svgEl.clientWidth, H = svgEl.clientHeight
  const scale  = 2  // retina quality

  const clone  = svgEl.cloneNode(true)
  clone.setAttribute('width',  W)
  clone.setAttribute('height', H)

  // The clone is a standalone SVG — HTML stylesheet rules don't apply.
  // Without these, SVG defaults kick in: fill:black on paths, etc.
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
  styleEl.textContent = `
    .edge-path { fill: none; }
    .dim { opacity: 0.05; }
    .node-label { fill: rgba(255,255,255,0.88); font-weight: 700;
                  pointer-events: none; user-select: none; }
    .node-circle.hi { filter: drop-shadow(0 0 7px currentColor); }
    .edge-path.hi-out { stroke: #e74c3c; }
    .edge-path.hi-in  { stroke: #3498db; }
  `
  clone.insertBefore(styleEl, clone.firstChild)

  // Background rect
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('width', W); bg.setAttribute('height', H); bg.setAttribute('fill', '#0f1117')
  clone.insertBefore(bg, clone.firstChild)

  const svgStr = new XMLSerializer().serializeToString(clone)
  const blob   = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
  const url    = URL.createObjectURL(blob)

  const canvas = document.createElement('canvas')
  canvas.width  = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)

  const img = new Image()
  img.onload = () => {
    ctx.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    const a = document.createElement('a')
    a.download = 'community-flow.png'
    a.href     = canvas.toDataURL('image/png')
    a.click()
  }
  img.onerror = () => {
    URL.revokeObjectURL(url)
    alert('Export failed — try a different browser (Chrome recommended).')
  }
  img.src = url
})

// ── SAMPLE DATA ──────────────────────────────────────────────────────────────
const SAMPLE_FLOW = `source_community,target_community,edge_count
0,0,5200
1,1,4800
2,2,3100
3,3,2700
4,4,1400
0,1,3200
1,0,1600
0,2,1100
2,0,380
1,2,870
2,3,1450
3,2,640
1,3,580
3,4,760
4,1,290
2,4,420
4,3,180`

const SAMPLE_MEMBERS = `node_id,username,display_name,pagerank,in_degree,out_degree,community_id
1,alice_anchor,Alice Anchor,0.0450,4800,42,0
2,bob_broadcast,Bob Broadcast,0.0380,4100,28,0
3,carol_media,Carol Media,0.0310,3500,55,0
4,dave_news,Dave News,0.0240,3100,19,0
5,emma_press,Emma Press,0.0180,2600,63,0
6,frank_tech,Frank Tech,0.0400,4600,35,1
7,grace_dev,Grace Dev,0.0330,3900,41,1
8,henry_code,Henry Code,0.0270,3300,30,1
9,iris_data,Iris Data,0.0210,2900,25,1
10,jack_ai,Jack AI,0.0160,2400,47,1
11,kate_science,Kate Science,0.0360,4200,38,2
12,leo_research,Leo Research,0.0290,3700,33,2
13,mia_analyst,Mia Analyst,0.0230,3200,28,2
14,noah_stats,Noah Stats,0.0180,2800,22,2
15,olivia_ml,Olivia ML,0.0130,2300,44,2
16,peter_policy,Peter Policy,0.0340,4000,36,3
17,quinn_gov,Quinn Gov,0.0270,3500,31,3
18,rachel_law,Rachel Law,0.0210,3000,26,3
19,sam_rights,Sam Rights,0.0160,2600,20,3
20,tara_civic,Tara Civic,0.0120,2100,38,3
21,uma_culture,Uma Culture,0.0300,3800,34,4
22,victor_art,Victor Art,0.0240,3300,29,4
23,wendy_music,Wendy Music,0.0190,2800,24,4
24,xavier_film,Xavier Film,0.0140,2400,18,4
25,yara_lit,Yara Literature,0.0100,1900,32,4`

const sampleBtn = document.getElementById('sample-btn')
let sampleActive = false

sampleBtn.addEventListener('click', () => {
  if (sampleActive) {
    // Second click → clear everything and go back to blank
    sampleActive = false
    sampleBtn.textContent = 'Sample data'
    state.flowData = null; state.memberData = null
    removeLS('flow'); removeLS('members')
    clearFileBtn('flow-label',    'flow-dot',    'flow-clear',    'Upload Flow CSV')
    clearFileBtn('members-label', 'members-dot', 'members-clear', 'Upload Members CSV')
    resetToBlank()
    return
  }
  sampleActive = true
  sampleBtn.textContent = 'Clear sample'
  state.flowData   = parseFlowCSV(SAMPLE_FLOW)
  state.memberData = parseMembersCSV(SAMPLE_MEMBERS)
  saveLS('flow',    SAMPLE_FLOW,    'sample_flow.csv')
  saveLS('members', SAMPLE_MEMBERS, 'sample_members.csv')
  markLoaded('flow-label',    'flow-dot',    'flow-clear',    'sample_flow.csv')
  markLoaded('members-label', 'members-dot', 'members-clear', 'sample_members.csv')
  document.getElementById('empty-state').style.display = 'none'
  document.getElementById('legend').style.display = 'block'
  initVisualization(state.flowData, state.memberData)
})

// Reset sampleActive if user loads their own files
function clearSampleState() { sampleActive = false; sampleBtn.textContent = 'Sample data' }
document.getElementById('flow-input').addEventListener('change',    clearSampleState)
document.getElementById('members-input').addEventListener('change', clearSampleState)

// ── UTILS ────────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

// ── RESTORE FROM LOCALSTORAGE ────────────────────────────────────────────────
;(function restoreSession() {
  try {
    const flowText    = localStorage.getItem('nv_flow')
    const flowName    = localStorage.getItem('nv_flow_name')
    const membersText = localStorage.getItem('nv_members')
    const membersName = localStorage.getItem('nv_members_name')
    if (flowText) {
      state.flowData = parseFlowCSV(flowText)
      markLoaded('flow-label', 'flow-dot', 'flow-clear', flowName || 'flow.csv')
    }
    if (membersText) {
      state.memberData = parseMembersCSV(membersText)
      markLoaded('members-label', 'members-dot', 'members-clear', membersName || 'members.csv')
    }
    if (flowText) tryRender()
  } catch(e) { /* localStorage not available */ }
})()
