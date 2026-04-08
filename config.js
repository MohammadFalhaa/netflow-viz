// ── CONFIG ──────────────────────────────────────────────────────────────────
// Edit these values to tune the visualization without touching app logic.

const CFG = {
  edge: {
    outColor:    '#e74c3c',
    inColor:     '#3498db',
    singleColor: '#e74c3c',  // single-direction edges → same red as dominant
    minWidth:    0.7,
    maxWidth:    9,
    curvOffset:  22,
    arrowLen:    14,
  },
  node: {
    minR: 9,
    maxR: 36,
    stroke: 'rgba(255,255,255,0.7)',
    strokeW: 1.5,
  },
  sim: {
    warmupTicks:  500,
    linkDist:     260,
    linkStrength: 0.06,   // low — prevents links from collapsing nodes to center
    charge:       -2200,  // strong repulsion to spread the graph
    collide:      32,
  },
  handles: {
    defaultSingle:  10,   // shown in single-community panel (max 20)
    defaultCompare:  5,   // shown per community in compare panel (max 20)
    max:            22,
  },
}
