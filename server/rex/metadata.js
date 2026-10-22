import forward from '../forward/metadata.js';

// Keep requiredVersion: removing it caused Rex's native import to fail.
// Restoring the Forward-compatible value passed the user's device A/B test.
export default { ...forward, id: 'logvar.rex.local' };
