# KinePath

*[Versione italiana](README.md)*

Website that replaces the Rhino/Grasshopper chain for **robotic extrusion 3D printing with KUKA**:

1. you load a **mesh or BREP** model,
2. the site proposes the best **orientation**; you choose the **print mode** (default: contour layers),
3. it computes the **toolpath that follows the contour** of the part within the set tolerance (default 0.2 mm), layer by layer,
4. it exports the **KUKA `.src`** file with the same structure as `Tavolino1.src` (INI, BASE/TOOL, extruder I/O, `LIN … C_DIS`, shutdown, homing).

Everything runs in the browser (TypeScript + Three.js + WebAssembly): the model is never uploaded to a server.

The site is in **Italian and English**: the EN / IT button at the top right switches the whole page (warnings, notes and orientations already computed included) and the choice is saved in the browser.

**Checks before export.** The *Download .src* button stays disabled:
- while a computation is running or after any change, until the latest computation has finished (an outdated result can never be downloaded);
- if a parameter is outside its admitted values ($VEL.CP, ANOUT outputs, n° of layers, safe position and homing pose within the axis limits, …): parameters are checked *before* computing, so an excessive value does not even start it;
- `BASE_DATA[1]`, `TOOL_DATA[11]` and E1–E4 = 0 are locked: they are the only configurations whose measurements the simulation and the reach check know;
- if the robot cannot reach a toolpath point or an intermediate point of a LIN (sampled every 20 mm), or an axis exceeds the KR16 limits;
- if a toolpath point goes below the work table (plate at Z 38 in BASE): this cannot be confirmed;
- if a number field is empty or invalid;
- if the toolpath leaves the work table in plan, or if with *tilt tool* some points have a slope along X that cannot be followed: these two cases need an explicit confirmation, reset at every change.

**Limits.** The site does not check collisions of the arm or spindle with the table and the part, nor the PTP motion to the safe positions. The check of the intermediate LIN points covers the programmed geometric path, not the blended trajectory the controller runs with `C_DIS` (default, like Tavolino1): with `C_DIS` the robot does not pass exactly through every point; the option *LIN approximation → None* makes the robot stop on every point. Before printing, the `.src` must still be run dry or in the simulation of the real cell.

## Fixed cell

When the site opens it already shows the cell, which cannot be moved or removed:

- **KUKA KR16 R2010** posed with its real kinematics (axes measured from the CAD: A2 at 160/520 mm, upper arm 980 mm, forearm 150/860 mm, flange 153.9 mm from the wrist);
- **spindle** mounted on the flange: its tip matches `TOOL_DATA[11] = {X 372.65, Y 0, Z 78.111}`;
- **boards and work plate** (print table at Z 38 in the BASE frame, 640 × 1350 mm).

The geometry comes from `BASE ROBOT.3dm` and is stored in `public/cell.bin` (≈2 MB). To rebuild it:

```bash
node scripts/build-cell.mjs "/path/BASE ROBOT.3dm"
```

The robot stands in the Rhino world at (0, −1000, 0): the point drawn in `BASE ROBOT.3dm` moved by −1000 in Y, centred on the table like the BASE, with its base 32 mm below the top of the boards. The BASE of the Python post-processor, (1448, −1000, 5) in world coordinates, is therefore at (1448, 0, 5) from the robot.

**Tool orientation.** The spindle axis is the TCP Z axis, as calibrated on the robot: with A = −180°, B = 0° the C parameter tilts the tool (C 180 = vertical pointing down, C 135 ≈ 45°, C 90 / 270 = horizontal). With A −180 / B 0 / C 180 the robot works vertically above the point.

**Simulation.** The *▶ Simulate* button makes the robot run the `LIN` moves of the `.src` file, at the real speed ($VEL.CP) multiplied by 1–500×. The part of the path already run is coloured, the rest stays light grey; below you see the current `LIN` line, the X/Y/Z/A/B/C values written in the file and the A1–A6 angles. The slider jumps to any move, the layer slider to the end of a layer. For every point the site solves the inverse kinematics and flags points out of reach or beyond the axis limits.

## Quick start

1. **Load the part**: a mesh or a BREP; a new file replaces the previous one. From a `.3dm` with the whole scene only the object standing on the work table is used.
2. The site proposes the best orientation (Orientation section); choose the print mode in *Printing*.
3. **Place part**: click on the plate in the view to move the centre of the part; the rotation on the table is in *KUKA robot and table → Part rotation Z*.
4. **Start point**: click near the contour where printing should start (light blue dot).
5. **Download .src**.

## Supported formats

| Format | How it is read |
|---|---|
| STL, OBJ, PLY | Three.js loaders (units assumed mm) |
| 3DM (Rhino) | rhino3dm: meshes, polysurfaces and extrusions (using the render meshes saved in the file), SubD. Units converted to mm |
| STEP, IGES, BREP | OpenCascade (occt-import-js), 0.1 mm tessellation |

The rhino3dm and OpenCascade libraries are served by the site itself (`public/vendor`, copied from `node_modules` at every build): importing needs no CDN and no network.

> `.3dm` polysurfaces without render meshes (files saved with "Save Small") cannot be read: open the file in Rhino in shaded view and save it again, or export STEP.

## How it works

- **Exact slicing**: every layer is the intersection of a plane with the mesh; segments are chained through the mesh topology (shared edges), so contours are closed and follow the real geometry. Douglas–Peucker simplification with adjustable tolerance (default 0.2 mm), optional splitting of long LIN moves (like "Divide Length").
- **Orientation**: tries ±X/±Y/±Z and the largest flat faces of the convex hull. Scored on overhangs beyond the critical angle, islands starting in mid-air, contours per layer (each separate contour = an extruder stop), contact area, height.
- **Print mode**: *contour layers* by default (constant Z per layer, layer change on the same vertical without stopping the extruder, like Tavolino1); between separate contours the extruder is switched off, the nozzle lifted and restarted. The other modes (spiral, solid, surface) are chosen from the menu: see the table below. The spiral is used only when every layer is a single contour, otherwise it falls back to planar layers.
- **Thin shells**: a hollow solid whose thickness is ≤ "Shell → mid-line" is printed with a single bead on its mid-line (instead of outer + inner skin).
- **Multiple walls**: inward offsets with Clipper.

### Print modes

| Mode | What it does |
|---|---|
| Contour layers | the contour of every layer at constant Z, +layer height at each layer (like Tavolino1) |
| Contour spiral | as above but Z rises along the turn (vase mode), no seam |
| Solid serpentine | the solid part with a continuous serpentine (pass after pass, like a lawn mower), optional outer contour. Whole planar layers up to below the lowest point of the top surface; then, with *blended layers*, N non-planar layers that go from flat to the shape of the surface (layer k at cut height + (surface − cut)·k/N): each covers the whole section, only its thickness changes (≈ ½–1½ layer heights), the last one is the real surface. No islands form and the extruder never stops (saddle: 13 planar + 17 blended, 0 stops). Automatic pass direction (0/45/90/135°, fewest breaks) |
| Top surface serpentine | non-planar: the serpentine follows the top surface of the part (faces steeper than *max slope* are sides and are excluded), half a bead from the border; several stacked layers with *n° of layers*. With *tilt tool* the C parameter follows the slope in the Y-Z plane (C = 180° − arccos(Nz) for slopes along Y, as in the A −180 / B 0 calibration); a slope along X cannot be expressed with C alone and is reported. Without the option the tool stays vertical. The result shows the *coverage*: the share of the top surface actually covered by the union of the deposited beads (≤ 2 mm grid), so local holes lower it; it is a grid measure, not a continuous check of every point |

## Position on the robot

Two modes (section *KUKA robot and table*):

- **Centre on the given point**: the centre of the part goes to `X/Y` and its base to *Part Z in BASE* (default 38, i.e. resting on the plate); the first pass is 0.5 mm above → Z 38.5 like Tavolino1. The field moves the part, not the plate: the plate and its grid always stay at Z 38, so a part placed lower is seen sinking into the table and export is blocked.
- **Keep the file position**: uses the position of the part in the Rhino file and subtracts the BASE origin in world coordinates (default 1448 / −1000 / 5, from the Python post-processor).

The controller data (`BASE_DATA[1]`, `TOOL_DATA[11]`, E1–E4 = 0) are fixed and used for the simulation and the reach check. The `.src` calls the controller's `BASE_DATA[1]` and `TOOL_DATA[11]` and, apart from the `LIN`/`PTP` moves, is byte-for-byte identical to `Tavolino1.src`.

All parameters are saved in the browser.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests (slicing, toolpath, orientation, KUKA writer)
npm run build    # static site in dist/
```

Optional test on a real Rhino file:

```bash
GB_SAMPLE_3DM="/path/file.3dm" GB_SAMPLE_LAYER="Livello 04" GB_SAMPLE_INDEX=0 npx vitest run tests/real-file.test.ts
```

Every push to `main` runs the tests and publishes the site on GitHub Pages.

## Structure

```
src/core/loaders.ts      file import → mesh (per layer/object)
src/core/mesh.ts         indexed mesh, vertex welding, transforms
src/core/slicer.ts       plane/mesh intersection → closed contours
src/core/walls.ts        inner walls and shell mid-line (Clipper)
src/core/orientation.ts  orientation analysis
src/core/toolpath.ts     toolpath: contour layers, spiral, solid, surface
src/core/zigzag.ts       serpentine fill and pass ordering
src/core/surface.ts      top surface: projection, normals, C parameter
src/core/kuka.ts         KRL .src writer
src/core/pipeline.ts     orientation → toolpath → .src
src/worker.ts            computation in a Web Worker
src/viewer.ts            3D view, clicks on the table
src/core/robot.ts        KUKA frames, KR16 forward/inverse kinematics
scripts/build-cell.mjs   extracts robot, boards and spindle from BASE ROBOT.3dm
public/cell.*            fixed cell
src/main.ts              user interface
src/i18n.ts              IT / EN translations
```
