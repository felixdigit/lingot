import { join } from 'path';
import { homedir } from 'os';

export const PACKAGES_DIR = join(homedir(), '.lingot', 'packages');
export const REGISTRY_URL = 'https://lingot.sh/api/v1';
