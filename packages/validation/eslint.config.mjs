import { ignores, nodeBase, noDirectProcessEnv } from '../config/eslint.base.mjs';

export default [ignores, ...nodeBase, noDirectProcessEnv];
