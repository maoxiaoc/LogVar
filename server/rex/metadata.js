import forward from '../forward/metadata.js';

// Rex uses the same Widget contract; do not copy Forward's minimum app version.
const { requiredVersion, ...shared } = forward;
export default { ...shared, id: 'logvar.rex.local' };
