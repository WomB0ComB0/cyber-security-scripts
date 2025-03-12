#!/bin/bash

# Script to create a standardized folder structure for cybersecurity scripts
# Usage: ./create_cybersec_repo.sh [target_directory]

# Set target directory (default to current directory if not specified)
TARGET_DIR=${1:-.}

# Confirm with user
echo "This will create a cybersecurity repository structure in: $TARGET_DIR"
read -p "Continue? (y/n): " confirm
if [[ $confirm != [yY] ]]; then
    echo "Operation cancelled."
    exit 0
fi

# Create main directories
echo "Creating main directory structure..."
mkdir -p "$TARGET_DIR"/{reconnaissance,vulnerability_scanning,exploitation,post_exploitation,forensics,defense,utilities,documentation,conf}

# Create subdirectories for reconnaissance
mkdir -p "$TARGET_DIR"/reconnaissance/{network_scanning,osint,passive_recon,active_recon}

# Create subdirectories for vulnerability scanning
mkdir -p "$TARGET_DIR"/vulnerability_scanning/{web,network,system,code_analysis}

# Create subdirectories for exploitation
mkdir -p "$TARGET_DIR"/exploitation/{web,network,wireless,social_engineering}

# Create subdirectories for post exploitation
mkdir -p "$TARGET_DIR"/post_exploitation/{privilege_escalation,persistence,data_exfiltration,lateral_movement}

# Create subdirectories for forensics
mkdir -p "$TARGET_DIR"/forensics/{disk_analysis,memory_analysis,network_analysis,log_analysis}

# Create subdirectories for defense
mkdir -p "$TARGET_DIR"/defense/{monitoring,incident_response,hardening,threat_hunting}

# Create subdirectories for utilities
mkdir -p "$TARGET_DIR"/utilities/{password_tools,encoding_decoding,automation,reporting}

# Create README files with descriptions
echo "Creating README files..."

# Main README
cat > "$TARGET_DIR"/README.md << 'EOF'
# Cybersecurity Scripts Repository

This repository contains various cybersecurity tools and scripts organized by their function in the security assessment lifecycle.

## Repository Structure

- **reconnaissance/** - Tools for gathering information about targets
- **vulnerability_scanning/** - Tools for identifying vulnerabilities
- **exploitation/** - Tools for exploiting identified vulnerabilities
- **post_exploitation/** - Tools for use after gaining access
- **forensics/** - Tools for investigating security incidents
- **defense/** - Tools for security monitoring and hardening
- **utilities/** - Supporting tools and utilities
- **documentation/** - Guides, checklists, and other documentation
- **conf/** - Configuration files and templates

## Usage

Each directory contains tools related to a specific phase or aspect of security testing. See individual directories for more detailed documentation.
EOF

# Create a simple .gitignore file
cat > "$TARGET_DIR"/.gitignore << 'EOF'
# Byte-compiled / optimized / DLL files
__pycache__/
*.py[cod]
*$py.class

# Distribution / packaging
dist/
build/
*.egg-info/

# Virtual environments
venv/
env/
ENV/

# IDE files
.idea/
.vscode/
*.swp
*.swo

# OS specific files
.DS_Store
Thumbs.db

# Log files
*.log

# Sensitive configuration files
*.conf
!example.conf
*.key
*.pem
*.cert
credentials.json
secret*

# Output files that may contain sensitive data
output/
results/
reports/
EOF

# Create a requirements.txt file
cat > "$TARGET_DIR"/requirements.txt << 'EOF'
# Core dependencies
requests>=2.25.0
cryptography>=3.4.0
pyyaml>=5.4.0
python-dotenv>=0.15.0

# Network tools
scapy>=2.4.4
paramiko>=2.7.2

# Web tools
beautifulsoup4>=4.9.3
selenium>=3.141.0

# Data processing
pandas>=1.2.0
numpy>=1.19.5

# Visualization
matplotlib>=3.3.3
EOF

echo "Repository structure created successfully in $TARGET_DIR"
find "$TARGET_DIR" -type d | sort

echo "Next steps:"
echo "1. Initialize git repository: cd $TARGET_DIR && git init"
echo "2. Create a virtual environment: python -m venv venv"
echo "3. Install dependencies: pip install -r requirements.txt"
echo "4. Start adding your scripts to the appropriate directories"