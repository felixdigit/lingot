import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REGISTRY_URL } from './config.js';

// Maps package.json dependency names to lingot block slugs
const DEPENDENCY_MAP = {
  '@supabase/supabase-js': 'supabase-auth',
  '@supabase/ssr': 'supabase-auth',
  'next': 'nextjs-app-router',
  'typescript': 'typescript-strict',
  'tailwindcss': 'tailwind-patterns',
  '@tailwindcss/vite': 'tailwind-v4',
  'drizzle-orm': 'drizzle-orm',
  'drizzle-kit': 'drizzle-orm',
  'zod': 'zod',
  'stripe': 'stripe-billing',
  '@aws-sdk/client-s3': 'aws-s3-v3',
  'resend': 'resend',
  '@tanstack/react-query': 'tanstack-query',
  '@prisma/client': 'prisma',
  'prisma': 'prisma',
  'openai': 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  'react-email': 'react-email',
  '@react-email/components': 'react-email',
  'ioredis': 'redis',
  '@upstash/redis': 'redis',
  'vitest': 'vitest',
  'framer-motion': 'framer-motion',
  'motion': 'framer-motion',
  'next-auth': 'next-auth',
  '@trpc/server': 'trpc',
  '@trpc/client': 'trpc',
  'react-hook-form': 'react-hook-form',
  '@clerk/nextjs': 'clerk',
  'mongoose': 'mongoose',
  'zustand': 'zustand',
  'uploadthing': 'uploadthing',
  '@uploadthing/react': 'uploadthing',
  'lucia': 'lucia-auth',
  'arctic': 'lucia-auth',
  'swr': 'swr',
  'eslint': 'eslint',
  '@playwright/test': 'playwright',
  'next-intl': 'next-intl',
  'convex': 'convex',
  'turbo': 'turborepo',
  'nuxt': 'nuxt',
  'cypress': 'cypress',
  'prettier': 'prettier',
};

export async function init() {
  const pkgPath = join(process.cwd(), 'package.json');

  if (!existsSync(pkgPath)) {
    console.error('No package.json found in current directory.');
    console.error('Run this command from your project root.');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  const detected = new Set();
  for (const dep of Object.keys(allDeps)) {
    if (DEPENDENCY_MAP[dep]) {
      detected.add(DEPENDENCY_MAP[dep]);
    }
  }

  if (detected.size === 0) {
    console.log('\nNo matching blocks found for your dependencies.');
    console.log('Browse all 40+ blocks at https://lingot.sh');
    return;
  }

  const blocks = [...detected].sort();

  console.log(`\nDetected ${blocks.length} relevant intelligence blocks:\n`);

  for (const slug of blocks) {
    console.log(`  lingot add ${slug}`);
  }

  console.log(`\nInstall all at once:`);
  console.log(`  lingot add ${blocks.join(' ')}`);

  // SaaS stack upsell — if user has auth + payments + db detected
  const hasSaasStack = detected.has('supabase-auth') || detected.has('next-auth') || detected.has('clerk');
  const hasPayments = detected.has('stripe-billing');
  const hasDb = detected.has('drizzle-orm') || detected.has('prisma') || detected.has('mongoose');

  if (hasSaasStack && (hasPayments || hasDb)) {
    console.log(`\n  \u{1F4A1} SaaS stack detected. Give your AI the integration patterns`);
    console.log(`     to wire auth, payments, and database together securely:`);
    console.log(`     npx lingot add saas-blueprint  (https://lingot.sh/blueprint)`);
  }

  console.log();
}
