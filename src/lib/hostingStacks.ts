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
    metaTitle: "Spring Boot Hosting for Indian Businesses — Java VPS Servers | Sowsi Cloud",
    metaDescription:
      "Host your Spring Boot and Java applications on NVMe VPS servers in Germany. Sudo access, install your own JDK, GST invoices, ticket and email support.",
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
      "Sowsi Cloud VPS plans give your Spring Boot and Java applications sudo access and NVMe SSD storage. Nothing is pre-installed, so you set up the JDK you want.",
    highlights: [
      "Sudo access to install any JDK version (8, 11, 17, 21)",
      "You can install Maven or Gradle for your builds",
      "NVMe SSD storage for fast application startup",
      "You can set up Nginx as a reverse proxy for port 8080",
      "UFW firewall set up, plus Hetzner's network DDoS protection",
    ],
    faqs: [
      { q: "Can I run multiple Spring Boot microservices on one VPS?", a: "Yes — VPS Pro and Elite have more RAM and vCPUs for running several services behind Nginx." },
      { q: "Do you support Java 21 and the latest LTS releases?", a: "Yes, you get sudo access so you can install any JDK version via SDKMAN, apt, or manual installation." },
      { q: "Can I connect a MySQL or PostgreSQL database?", a: "Yes, you can install MySQL or PostgreSQL on the VPS yourself." },
    ],
  },
  {
    slug: "nodejs",
    name: "Node.js Hosting",
    icon: "🟩",
    tagline: "High-performance VPS hosting for Node.js, Express, and Next.js apps",
    category: "VPS",
    metaTitle: "Node.js Hosting for Indian Businesses — NVMe VPS for Node & Express | Sowsi Cloud",
    metaDescription:
      "Node.js hosting on NVMe VPS servers for Express, Next.js, NestJS, and API backends. Sudo access, install your own Node and PM2, GST invoices.",
    keywords: [
      "node js hosting india",
      "nodejs vps hosting",
      "express js hosting",
      "next js hosting india",
      "javascript backend hosting",
      "npm hosting server",
    ],
    intro:
      "Run your Node.js, Express, NestJS, or Next.js backend on your own VPS with sudo access. Nothing is pre-installed: you install any Node version and use PM2 for process management.",
    highlights: [
      "Install any Node.js version via NVM",
      "You can use PM2 or systemd to manage processes",
      "NVMe SSD storage for fast npm installs and builds",
      "You can set up Nginx as a reverse proxy for port 3000/4000 apps",
      "WebSocket & long-lived connection support",
      "Ports 80 and 443 are open for your own SSL",
    ],
    faqs: [
      { q: "Can I host a Next.js app with SSR on your VPS?", a: "Yes, Next.js SSR/API routes run great on our VPS plans — just set up Node, PM2, and an Nginx reverse proxy." },
      { q: "Do you support WebSockets?", a: "Yes, our VPS plans fully support long-lived WebSocket connections for real-time apps." },
      { q: "Can I use PM2 to manage my Node processes?", a: "Yes, you can install PM2 or use systemd with sudo access." },
    ],
  },
  {
    slug: "python-django",
    name: "Python & Django Hosting",
    icon: "🐍",
    tagline: "Reliable VPS hosting for Python, Django, and Flask applications",
    category: "VPS",
    metaTitle: "Python & Django Hosting for Indian Businesses — VPS for Python Apps | Sowsi Cloud",
    metaDescription:
      "Host Python, Django, and Flask applications on NVMe VPS servers in Germany. Sudo access to install virtualenv, Gunicorn or uWSGI yourself.",
    keywords: [
      "python hosting india",
      "django hosting india",
      "flask hosting",
      "python vps hosting",
      "django vps server",
      "gunicorn hosting",
    ],
    intro:
      "Deploy Django, Flask, or any Python web application on your own VPS with sudo access. Nothing is pre-installed: you set up virtualenv, Gunicorn, uWSGI, or your framework of choice.",
    highlights: [
      "Sudo access to install Python 3.x, pip and virtualenv",
      "You can run Gunicorn, uWSGI or an ASGI server",
      "NVMe SSD storage for fast dependency installs",
      "You can install PostgreSQL or MySQL for the Django ORM",
      "You can set up Nginx as a reverse proxy",
      "Cron is available for scheduled tasks",
    ],
    faqs: [
      { q: "Can I run Celery workers alongside Django?", a: "Yes, VPS Pro and Elite have more RAM and vCPUs for running Django, Celery workers and Redis together." },
      { q: "Do you support virtual environments?", a: "Yes, sudo access lets you use venv, virtualenv, poetry, or pipenv as you prefer." },
      { q: "Can I host a Flask microservice?", a: "Yes, Flask, FastAPI, and other lightweight Python frameworks all run well on our VPS plans." },
    ],
  },
  {
    slug: "fastapi",
    name: "FastAPI Hosting",
    icon: "⚡",
    tagline: "VPS hosting for FastAPI and async Python APIs",
    category: "VPS",
    metaTitle: "FastAPI Hosting for Indian Businesses — Async Python API Hosting | Sowsi Cloud",
    metaDescription:
      "Host your FastAPI applications on NVMe VPS servers. Sudo access to install Uvicorn or Gunicorn yourself, ticket and email support.",
    keywords: [
      "fastapi hosting india",
      "fastapi vps hosting",
      "async python hosting",
      "uvicorn hosting",
      "python api hosting india",
    ],
    intro:
      "Our VPS plans give you shared vCPUs, NVMe SSD storage, and sudo access to run Uvicorn or Gunicorn workers the way you want. Nothing is pre-installed.",
    highlights: [
      "You can configure Uvicorn and Gunicorn workers",
      "Sudo access for Python 3.10+ and async libraries",
      "NVMe SSD for fast cold starts",
      "You can set up Nginx with HTTP/2 as a reverse proxy",
      "You can install PostgreSQL, Redis and background workers",
    ],
    faqs: [
      { q: "Does FastAPI's async support work well on your VPS?", a: "Yes, async FastAPI apps run as they would on any Linux server. vCPUs are shared." },
      { q: "Can I run multiple Uvicorn workers?", a: "Yes, VPS Pro and Elite have more vCPUs for running several Uvicorn or Gunicorn workers behind Nginx." },
    ],
  },
  {
    slug: "machine-learning",
    name: "Machine Learning & AI Hosting",
    icon: "🤖",
    tagline: "VPS servers for ML model serving and AI APIs",
    category: "VPS",
    metaTitle: "Machine Learning & AI Hosting for Indian Businesses — ML Model Server VPS | Sowsi Cloud",
    metaDescription:
      "Host machine learning models, AI inference APIs, and data pipelines on NVMe VPS servers. Sudo access to install Python, PyTorch or TensorFlow yourself.",
    keywords: [
      "machine learning hosting india",
      "ml model hosting",
      "ai api hosting india",
      "pytorch hosting",
      "tensorflow hosting vps",
      "data science server hosting",
    ],
    intro:
      "Serve machine learning models and AI-powered APIs on CPU-only VPS servers with up to 16 GB RAM and sudo access, for inference endpoints, data pipelines and light training jobs.",
    highlights: [
      "Plans with up to 16 GB RAM",
      "Sudo access for PyTorch, TensorFlow and scikit-learn installs",
      "NVMe SSD storage for fast dataset & model I/O",
      "You can serve models with FastAPI or Flask",
      "Cron and background jobs for batch pipelines",
    ],
    faqs: [
      { q: "Can I serve a PyTorch or TensorFlow model for inference?", a: "Yes, you can serve models from a FastAPI or Flask API. How much RAM you need depends on the model." },
      { q: "Do you offer GPU hosting?", a: "No. Our plans are CPU-only VPS, for light inference and ML workloads." },
      { q: "Can I run scheduled model retraining jobs?", a: "Yes, you can run cron jobs and background workers with sudo access." },
    ],
  },
  {
    slug: "mobile-app-backend",
    name: "Mobile App Backend Hosting",
    icon: "📱",
    tagline: "VPS backend hosting for iOS & Android apps, REST & GraphQL APIs",
    category: "VPS",
    metaTitle: "Mobile App Backend Hosting for Indian Businesses — API Server for iOS & Android | Sowsi Cloud",
    metaDescription:
      "Host your mobile app backend, REST/GraphQL API, and push-notification services on NVMe VPS servers in Germany. Sudo access, ticket and email support.",
    keywords: [
      "mobile app backend hosting india",
      "app backend server hosting",
      "rest api hosting india",
      "graphql hosting",
      "ios android backend hosting",
      "firebase alternative hosting india",
    ],
    intro:
      "Whether your mobile app backend runs on Node.js, Django, Spring Boot, or Laravel — our VPS plans give you your own VPS to host REST/GraphQL APIs, authentication, and push-notification services.",
    highlights: [
      "Run any backend stack: Node.js, Django, Spring Boot, Laravel, and more",
      "Ports 80 and 443 are open for your own SSL",
      "NVMe SSD storage for fast API response times",
      "Sudo access for custom auth, push notification and socket servers",
      "UFW firewall set up, plus Hetzner's network DDoS protection",
    ],
    faqs: [
      { q: "Can I host both my API and database on the same VPS?", a: "Yes, VPS Pro and Elite have more RAM and vCPUs for running your API server and database together." },
      { q: "Is this suitable for a production app backend?", a: "VPS Pro has 4 GB RAM and 2 shared vCPUs. There's no SLA, and we don't back up your server, so keep your own backups." },
      { q: "Can I set up push notifications (FCM/APNs) on this server?", a: "Yes, you get sudo access to install any push notification SDK or service on your backend." },
    ],
  },
  {
    slug: "automation",
    name: "Automation & Bot Hosting",
    icon: "⚙️",
    tagline: "Always-on VPS hosting for automation scripts, bots, and scheduled workflows",
    category: "VPS",
    metaTitle: "Automation & Bot Hosting for Indian Businesses — VPS for Scripts & Workflows | Sowsi Cloud",
    metaDescription:
      "Run Python/Node.js automation scripts, Telegram/Discord bots, and web scrapers on your own NVMe VPS. Sudo access and cron jobs.",
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
      "Keep your automation scripts, bots, and workflow engines running without relying on your local machine. Our VPS plans support cron jobs, background workers, and always-on processes for any language.",
    highlights: [
      "Run bots, cron jobs and background workers continuously",
      "Run Python, Node.js, or any language automation script",
      "Install workflow tools yourself with sudo access",
      "NVMe SSD storage for fast script execution",
      "UFW firewall set up, plus Hetzner's network DDoS protection",
      "You can use PM2, systemd or supervisor to manage processes",
    ],
    faqs: [
      { q: "Can I keep a Telegram or Discord bot running?", a: "Yes, VPS Basic can keep a small bot running with PM2 or systemd." },
      { q: "Do you support cron jobs for scheduled tasks?", a: "Yes, standard Linux cron is available on all VPS plans." },
    ],
  },
];

export function getStackBySlug(slug: string): HostingStack | undefined {
  return HOSTING_STACKS.find((s) => s.slug === slug);
}
