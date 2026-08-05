// Re-export shim. The implementation lives in the physics package, which owns it:
// it is pure rigid-body maths with no dependencies, and keeping it inside that
// package keeps the package self-contained (it is published as engine-agnostic and
// must not reach outside its own directory).
//
// Import from here in the labs so there is one path to remember.
export {
  massProperties,
  principalAxes,
  shapeDescriptors,
} from "../stone-skipping-physics/src/meshMassProperties.js";
