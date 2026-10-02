export type HostingCategory = "SHARED" | "VPS" | "WORDPRESS" | "STORAGE" | "DEDICATED";

export type HostingStack = {
  slug: string;
  name: string;
  icon: string;
  tagline: string;
  category: HostingCategory;
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
  intro: string;
  highlights: string[];
  faqs: { q: string; a: string }[];
};

export const HOSTING_STACKS: HostingStack[] = [
  {
    slug: "spring-boot",
    name: "Spring Boot Hosting",
    icon: "☕",
    tagline: "Deploy Java Spring Boot apps on high-performance VPS servers",
    category: "VPS",
    metaTitle: "Spring Boot Hosting in India — Fast Java VPS Servers | Sowsi Cloud",
    metaDescription:
      "Host your Spring Boot and Java applications on blazing-fast NVMe VPS servers in India. Root access, JDK-ready environments, 99.9% uptime SLA, GST invoices, 24/7 support.",
    keywords: [
      "spring boot hosting india",
      "java hosting india",
      "spring boot vps",
      "java application hosting",
      "spring boot server hosting",
      "jvm hosting india",
      "maven gradle hosting",
    ],
    intro:
      "Sowsi Cloud VPS plans give your Spring Boot and Java applications full root access, dedicated resources, and NVMe SSD storage — everything you need to run production-grade JVM workloads without noisy neighbors.",
    highlights: [
      "Full root access to install any JDK version (8, 11, 17, 21)",
      "Pre-configured for Maven & Gradle builds",
      "NVMe SSD storage for fast application startup",
      "Dedicated vCPU cores — no CPU throttling under load",
      "Easy reverse-proxy setup with Nginx for Spring Boot on port 8080",
      "Firewall & DDoS protection included",
    ],
    faqs: [
      { q: "Can I run multiple Spring Boot microservices on one VPS?", a: "Yes — our VPS Business and Pro plans include enough RAM and vCPU cores to run multiple Spring Boot services behind Nginx or a reverse proxy." },
      { q: "Do you support Java 21 and the latest LTS releases?", a: "Yes, you get full root access so you can install any JDK version via SDKMAN, apt, or manual installation." },
      { q: "Can I connect a MySQL or PostgreSQL database?", a: "Yes, you can install MySQL/PostgreSQL directly on the VPS or connect to our managed Object Storage and database add-ons." },
    ],
  },
  {
    slug: "nodejs",
    name: "Node.js Hosting",
    icon: "🟩",
    tagline: "High-performance VPS hosting for Node.js, Express, and Next.js apps",
    category: "VPS",
    metaTitle: "Node.js Hosting in India — NVMe VPS for Node & Express | Sowsi Cloud",
    metaDescription:
      "Fast, reliable Node.js hosting on NVMe VPS servers. Perfect for Express, Next.js, NestJS, and API backends. Root access, PM2-ready, 99.9% uptime, GST invoices.",
    keywords: [
      "node js hosting india",
      "nodejs vps hosting",
      "express js hosting",
      "next js hosting india",
      "javascript backend hosting",
      "npm hosting server",
    ],
    intro:
      "Run your Node.js, Express, NestJS, or Next.js backend on a dedicated VPS with full root access — install any Node version, use PM2 for process management, and scale as your traffic grows.",
    highlights: [
      "Install any Node.js version via NVM",
      "PM2 / systemd process management supported",
      "NVMe SSD storage for fast npm installs and builds",
      "Reverse proxy ready with Nginx for port 3000/4000 apps",
      "WebSocket & long-lived connection support",
      "Free SSL via Let's Encrypt for your API domains",
    ],
    faqs: [
      { q: "Can I host a Next.js app with SSR on your VPS?", a: "Yes, Next.js SSR/API routes run great on our VPS plans — just set up Node, PM2, and an Nginx reverse proxy." },
      { q: "Do you support WebSockets?", a: "Yes, our VPS plans fully support long-lived WebSocket connections for real-time apps." },
      { q: "Can I use PM2 to manage my Node processes?", a: "Yes, PM2, systemd, or Docker all work fine with full root access." },
    ],
  },
  {
    slug: "python-django",
    name: "Python & Django Hosting",
    icon: "🐍",
    tagline: "Reliable VPS hosting for Python, Django, and Flask applications",
    category: "VPS",
    metaTitle: "Python & Django Hosting in India — VPS for Python Apps | Sowsi Cloud",
    metaDescription:
      "Host Python, Django, and Flask applications on fast NVMe VPS servers in India. Root access, virtualenv-ready, Gunicorn/uWSGI support, 99.9% uptime SLA.",
    keywords: [
      "python hosting india",
      "django hosting india",
      "flask hosting",
      "python vps hosting",
      "django vps server",
      "gunicorn hosting",
    ],
    intro:
      "Deploy Django, Flask, or any Python web application on a dedicated VPS with full root access. Set up virtualenv, Gunicorn, uWSGI, or your framework of choice — no shared-hosting limitations.",
    highlights: [
      "Full root access — install Python 3.x, pip, virtualenv freely",
      "Gunicorn / uWSGI / ASGI server support",
      "NVMe SSD storage for fast dependency installs",
      "PostgreSQL/MySQL install support for Django ORM",
      "Nginx reverse proxy setup for production deployments",
      "Cron job support for Celery workers & scheduled tasks",
    ],
    faqs: [
      { q: "Can I run Celery workers alongside Django?", a: "Yes, our VPS Business and Pro plans have enough resources to run Django, Celery workers, and Redis together." },
      { q: "Do you support virtual environments?", a: "Yes, full root access lets you use venv, virtualenv, poetry, or pipenv as you prefer." },
      { q: "Can I host a Flask microservice?", a: "Yes, Flask, FastAPI, and other lightweight Python frameworks all run well on our VPS plans." },
    ],
  },
  {
    slug: "fastapi",
    name: "FastAPI Hosting",
    icon: "⚡",
    tagline: "Low-latency VPS hosting built for FastAPI and async Python APIs",
    category: "VPS",
    metaTitle: "FastAPI Hosting in India — Async Python API Hosting | Sowsi Cloud",
    metaDescription:
      "Host your FastAPI applications on high-performance NVMe VPS servers. Uvicorn/Gunicorn ready, async support, root access, 99.9% uptime SLA, 24/7 support.",
    keywords: [
      "fastapi hosting india",
      "fastapi vps hosting",
      "async python hosting",
      "uvicorn hosting",
      "python api hosting india",
    ],
    intro:
      "FastAPI apps need low latency and async support — our VPS plans give you dedicated vCPU cores, NVMe SSD storage, and full root access to run Uvicorn/Gunicorn workers exactly how you want.",
    highlights: [
      "Uvicorn + Gunicorn worker configuration support",
      "Full root access for Python 3.10+ and async libraries",
      "NVMe SSD for fast cold starts",
      "Dedicated vCPU cores for low-latency API responses",
      "Nginx reverse proxy with HTTP/2 support",
      "Easy integration with PostgreSQL, Redis, and background workers",
    ],
    faqs: [
      { q: "Does FastAPI's async support work well on your VPS?", a: "Yes, our dedicated vCPU cores and NVMe storage are ideal for async I/O-heavy FastAPI workloads." },
      { q: "Can I run multiple Uvicorn workers?", a: "Yes, our VPS Business and Pro plans have enough CPU cores to run multiple Uvicorn/Gunicorn workers behind Nginx." },
      { q: "Is Docker supported for FastAPI deployments?", a: "Yes, you get full root access so you can install Docker and deploy containerized FastAPI apps." },
    ],
  },
  {
    slug: "machine-learning",
    name: "Machine Learning & AI Hosting",
    icon: "🤖",
    tagline: "High-RAM VPS servers for ML model serving, training jobs, and AI APIs",
    category: "VPS",
    metaTitle: "Machine Learning & AI Hosting in India — ML Model Server VPS | Sowsi Cloud",
    metaDescription:
      "Host machine learning models, AI inference APIs, and data pipelines on high-RAM NVMe VPS servers. Root access, Python/PyTorch/TensorFlow ready, 99.9% uptime.",
    keywords: [
      "machine learning hosting india",
      "ml model hosting",
      "ai api hosting india",
      "pytorch hosting",
      "tensorflow hosting vps",
      "data science server hosting",
    ],
    intro:
      "Serve machine learning models and AI-powered APIs on high-RAM, high-vCPU VPS servers. Ideal for inference endpoints, data pipelines, and lightweight training jobs with full root access.",
    highlights: [
      "High RAM plans for loading large ML models in memory",
      "Full root access for PyTorch, TensorFlow, scikit-learn installs",
      "NVMe SSD storage for fast dataset & model I/O",
      "Dedicated vCPU cores for consistent inference latency",
      "Support for FastAPI/Flask model-serving APIs",
      "Cron & background job support for batch pipelines",
    ],
    faqs: [
      { q: "Can I serve a PyTorch or TensorFlow model for inference?", a: "Yes, our high-RAM VPS Pro plan is well-suited for serving ML models via a FastAPI or Flask inference API." },
      { q: "Do you offer GPU hosting?", a: "Our current plans are CPU-based VPS, ideal for inference and lightweight ML workloads. Contact sales for custom GPU requirements." },
      { q: "Can I run scheduled model retraining jobs?", a: "Yes, cron jobs and background workers are fully supported with root access." },
    ],
  },
  {
    slug: "mobile-app-backend",
    name: "Mobile App Backend Hosting",
    icon: "📱",
    tagline: "Scalable VPS backend hosting for iOS & Android apps, REST & GraphQL APIs",
    category: "VPS",
    metaTitle: "Mobile App Backend Hosting in India — API Server for iOS & Android | Sowsi Cloud",
    metaDescription:
      "Host your mobile app backend, REST/GraphQL API, and push-notification services on secure NVMe VPS servers in India. 99.9% uptime SLA, root access, 24/7 support.",
    keywords: [
      "mobile app backend hosting india",
      "app backend server hosting",
      "rest api hosting india",
      "graphql hosting",
      "ios android backend hosting",
      "firebase alternative hosting india",
    ],
    intro:
      "Whether your mobile app backend runs on Node.js, Django, Spring Boot, or Laravel — our VPS plans give you a secure, dedicated server to host REST/GraphQL APIs, authentication, and push-notification services.",
    highlights: [
      "Run any backend stack: Node.js, Django, Spring Boot, Laravel, and more",
      "Secure REST & GraphQL API hosting with SSL",
      "NVMe SSD storage for fast API response times",
      "Root access for custom auth, push notification & socket servers",
      "DDoS protection & firewall for public-facing APIs",
      "Daily backup add-ons to protect your app database",
    ],
    faqs: [
      { q: "Can I host both my API and database on the same VPS?", a: "Yes, our VPS Business and Pro plans have enough resources to run your API server and database together, or you can pair with our Object Storage plans." },
      { q: "Is this suitable for a production app backend?", a: "Yes, our VPS Pro plan with 99.99% SLA and dedicated resources is built for production mobile app backends." },
      { q: "Can I set up push notifications (FCM/APNs) on this server?", a: "Yes, you get full root access to install any push notification SDK or service on your backend." },
    ],
  },
  {
    slug: "automation",
    name: "Automation & Bot Hosting",
    icon: "⚙️",
    tagline: "Always-on VPS hosting for automation scripts, bots, and scheduled workflows",
    category: "VPS",
    metaTitle: "Automation & Bot Hosting in India — 24/7 VPS for Scripts & Workflows | Sowsi Cloud",
    metaDescription:
      "Run Python/Node.js automation scripts, Telegram/Discord bots, web scrapers, and n8n/Zapier-style workflows 24/7 on a dedicated NVMe VPS. Root access, cron jobs, 99.9% uptime.",
    keywords: [
      "automation hosting india",
      "bot hosting vps",
      "telegram bot hosting",
      "discord bot hosting india",
      "n8n hosting india",
      "web scraper hosting",
      "cron job server hosting",
    ],
    intro:
      "Keep your automation scripts, bots, and workflow engines running 24/7 without relying on your local machine. Our VPS plans support cron jobs, background workers, and always-on processes for any language.",
    highlights: [
      "24/7 uptime for bots, cron jobs & background workers",
      "Run Python, Node.js, or any language automation script",
      "Self-host workflow tools like n8n with full root access",
      "NVMe SSD storage for fast script execution",
      "Firewall & DDoS protection for public webhook endpoints",
      "Easy PM2 / systemd / supervisor process management",
    ],
    faqs: [
      { q: "Can I self-host n8n or similar workflow automation tools?", a: "Yes, our VPS plans have full root access and Docker support, perfect for self-hosting n8n, Node-RED, or similar tools." },
      { q: "Can I run a Telegram or Discord bot 24/7?", a: "Yes, our VPS Starter plan is enough to keep a bot running continuously with PM2 or systemd." },
      { q: "Do you support cron jobs for scheduled tasks?", a: "Yes, standard Linux cron is available with full root access on all VPS plans." },
    ],
  },
  {
    slug: "website",
    name: "Website & Business Hosting",
    icon: "🌐",
    tagline: "Affordable shared & WordPress hosting for business websites",
    category: "SHARED",
    metaTitle: "Website Hosting in India — Fast & Affordable Business Hosting | Sowsi Cloud",
    metaDescription:
      "Reliable website hosting for Indian businesses. NVMe SSD storage, free SSL, 99.9% uptime, GST invoices, UPI payments, and 24/7 support.",
    keywords: [
      "website hosting india",
      "business website hosting",
      "cheap web hosting india",
      "shared hosting india",
      "domain hosting india",
    ],
    intro:
      "Launch your business website with fast, affordable shared hosting built for Indian businesses — NVMe SSD storage, free SSL, unlimited bandwidth, and GST-compliant billing.",
    highlights: [
      "NVMe SSD storage for fast page loads",
      "Free SSL certificate on every plan",
      "One-click website & CMS installs",
      "Unlimited bandwidth on all plans",
      "GST invoices and UPI payment support",
      "24/7 support in English, Hindi, and Telugu",
    ],
    faqs: [
      { q: "Is this suitable for a small business website?", a: "Yes, our Shared Starter and Business plans are ideal for brochure sites, portfolios, and small business websites." },
      { q: "Can I install WordPress on shared hosting?", a: "Yes, but for the best WordPress experience we recommend our dedicated WordPress Hosting plans with pre-optimized caching." },
      { q: "Do you provide free SSL certificates?", a: "Yes, every plan includes a free SSL certificate via Let's Encrypt." },
    ],
  },
  {
    slug: "wordpress",
    name: "WordPress Hosting",
    icon: "📝",
    tagline: "Managed WordPress hosting optimized for speed and security",
    category: "WORDPRESS",
    metaTitle: "WordPress Hosting in India — Managed & Optimized | Sowsi Cloud",
    metaDescription:
      "Managed WordPress hosting with pre-installed caching, free SSL, daily backups, and 99.9% uptime. Built for Indian businesses and bloggers.",
    keywords: [
      "wordpress hosting india",
      "managed wordpress hosting",
      "fast wordpress hosting",
      "wordpress hosting for blogs",
      "woocommerce hosting india",
    ],
    intro:
      "Purpose-built WordPress hosting with pre-configured caching, security hardening, and one-click staging — everything you need for a fast, secure WordPress site or WooCommerce store.",
    highlights: [
      "Pre-installed WordPress with optimized caching",
      "Free SSL and automatic security updates",
      "Daily backups with easy one-click restore",
      "WooCommerce-ready for online stores",
      "NVMe SSD storage for fast page loads",
      "24/7 WordPress-expert support",
    ],
    faqs: [
      { q: "Do you support WooCommerce stores?", a: "Yes, our WordPress Business and Enterprise plans are optimized for WooCommerce stores with higher traffic." },
      { q: "Are backups included?", a: "Yes, daily automated backups are included on all WordPress hosting plans." },
      { q: "Can I migrate my existing WordPress site?", a: "Yes, our team offers free migration assistance when you sign up." },
    ],
  },
];

export function getStackBySlug(slug: string): HostingStack | undefined {
  return HOSTING_STACKS.find((s) => s.slug === slug);
}
