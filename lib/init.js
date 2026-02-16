import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REGISTRY_URL } from './config.js';

// Maps package.json dependency names to lingot block slugs
const DEPENDENCY_MAP = {
  // Auth
  '@supabase/supabase-js': 'supabase-auth',
  '@supabase/ssr': 'supabase-auth',
  'next-auth': 'next-auth',
  '@clerk/nextjs': 'clerk',
  '@clerk/express': 'clerk',
  'lucia': 'lucia-auth',
  'arctic': 'lucia-auth',
  'better-auth': 'better-auth',
  'passport': 'passport',
  'jose': 'jose',

  // Frameworks
  'next': 'nextjs-app-router',
  'nuxt': 'nuxt',
  'astro': 'astro',
  'svelte': 'svelte',
  '@sveltejs/kit': 'svelte',
  'vue': 'vue',
  '@remix-run/node': 'remix',
  '@remix-run/react': 'remix',
  'react-router': 'react-router-v7',
  'hono': 'hono',

  // Backend
  'express': 'express',
  'fastify': 'fastify',
  'socket.io': 'socket-io',
  '@apollo/server': 'graphql',
  'graphql': 'graphql',

  // Database / ORM
  'drizzle-orm': 'drizzle-orm',
  'drizzle-kit': 'drizzle-orm',
  '@prisma/client': 'prisma',
  'prisma': 'prisma',
  'mongoose': 'mongoose',
  'sequelize': 'sequelize',
  'typeorm': 'typeorm',
  'knex': 'knex',

  // Frontend
  'tailwindcss': 'tailwind-patterns',
  '@tailwindcss/vite': 'tailwind-v4',
  'framer-motion': 'framer-motion',
  'motion': 'framer-motion',
  'react-hook-form': 'react-hook-form',
  'zustand': 'zustand',
  'swr': 'swr',
  '@tanstack/react-query': 'tanstack-query',
  '@mdx-js/react': 'mdx',
  '@next/mdx': 'mdx',
  'i18next': 'i18next',
  'next-intl': 'next-intl',

  // Payments
  'stripe': 'stripe-billing',

  // AI SDKs
  'openai': 'openai',
  '@anthropic-ai/sdk': 'anthropic',

  // Email
  'resend': 'resend',
  'react-email': 'react-email',
  '@react-email/components': 'react-email',

  // Storage / Cloud
  '@aws-sdk/client-s3': 'aws-s3-v3',
  'firebase': 'firebase',
  'firebase-admin': 'firebase',
  'uploadthing': 'uploadthing',
  '@uploadthing/react': 'uploadthing',
  'ioredis': 'redis',
  '@upstash/redis': 'redis',
  'bullmq': 'bullmq',
  'convex': 'convex',

  // Testing
  'vitest': 'vitest',
  'jest': 'jest',
  '@playwright/test': 'playwright',
  'cypress': 'cypress',
  '@storybook/react': 'storybook',

  // DevOps / Tooling
  'typescript': 'typescript-strict',
  'eslint': 'eslint',
  'prettier': 'prettier',
  'turbo': 'turborepo',
  'vite': 'vite',

  // Observability
  '@sentry/node': 'sentry',
  '@sentry/nextjs': 'sentry',
  'pino': 'pino',
  'posthog-js': 'posthog',
  'posthog-node': 'posthog',

  // HTTP / Utilities
  'axios': 'axios',
  'puppeteer': 'puppeteer',
  'sharp': 'sharp',
  'date-fns': 'date-fns',

  // Validation
  'zod': 'zod',
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
    console.log('Browse all 77 blocks at https://lingot.sh');
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
