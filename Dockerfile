# Claude Code Server - Development Environment
# Based on Ubuntu 24.04 LTS

FROM ubuntu:24.04

LABEL maintainer="Claude Code Server"
LABEL description="Docker-based Claude Code development environment"

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Berlin

# Install base packages and dependencies
RUN apt-get update && apt-get install -y \
    # Basic utilities
    curl \
    wget \
    gnupg \
    ca-certificates \
    apt-transport-https \
    software-properties-common \
    lsb-release \
    # Build essentials
    build-essential \
    gcc \
    g++ \
    make \
    cmake \
    # Version control
    git \
    git-lfs \
    # Networking tools
    openssh-client \
    netcat-openbsd \
    # Text editors and utilities
    vim \
    nano \
    less \
    jq \
    tree \
    zip \
    unzip \
    # Process management
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Java 21 (Eclipse Temurin)
RUN curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/adoptium.list \
    && apt-get update \
    && apt-get install -y temurin-21-jdk \
    && rm -rf /var/lib/apt/lists/*

# Install Maven
ARG MAVEN_VERSION=3.9.6
RUN curl -fsSL https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz | tar xzf - -C /opt \
    && ln -s /opt/apache-maven-${MAVEN_VERSION} /opt/maven \
    && ln -s /opt/maven/bin/mvn /usr/local/bin/mvn

# Install Gradle
ARG GRADLE_VERSION=8.5
RUN curl -fsSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -o /tmp/gradle.zip \
    && unzip /tmp/gradle.zip -d /opt \
    && ln -s /opt/gradle-${GRADLE_VERSION} /opt/gradle \
    && ln -s /opt/gradle/bin/gradle /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

# Install Python 3.12
RUN add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y \
    python3.12 \
    python3.12-venv \
    python3.12-dev \
    python3-pip \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1 \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.12 1 \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for Docker-in-Docker support)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Rename existing ubuntu user to claude (Ubuntu 24.04 has ubuntu:1000)
RUN if id ubuntu &>/dev/null; then \
        usermod -l claude -d /home/claude -m ubuntu && \
        groupmod -n claude ubuntu; \
    else \
        groupadd -g 1000 claude && \
        useradd -m -u 1000 -g claude -s /bin/bash claude; \
    fi \
    && mkdir -p /home/claude/.ssh /home/claude/workspace /home/claude/.npm-global \
    && chown -R claude:claude /home/claude

# Add claude to docker group (will be created if docker socket is mounted)
RUN groupadd -f docker && usermod -aG docker claude

# Set npm global directory for non-root user
ENV NPM_CONFIG_PREFIX=/home/claude/.npm-global
ENV PATH=/home/claude/.npm-global/bin:$PATH

# Switch to claude user for npm install
USER claude
WORKDIR /home/claude

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Switch back to root for final setup
USER root

# Copy scripts
COPY --chown=claude:claude scripts/ /scripts/
RUN chmod +x /scripts/*.sh 2>/dev/null || true

# Expose API port
EXPOSE 3100

# Set environment variables
ENV JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH="${JAVA_HOME}/bin:${MAVEN_HOME}/bin:${GRADLE_HOME}/bin:${PATH}"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node --version && claude --version || exit 1

# Switch to claude user
USER claude
WORKDIR /home/claude/workspace

# Set entrypoint
ENTRYPOINT ["/scripts/entrypoint.sh"]
CMD ["idle"]
