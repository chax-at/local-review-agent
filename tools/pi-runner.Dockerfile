# syntax = docker/dockerfile:1
#
# Builds the pi runner image. Two shapes come out of this one file:
#  - the default runner, FROM node:lts-slim
#  - a derived runner, FROM a per-repo base image (php:8.3-cli, python:3.12, ...)
#
# A per-repo base image carries that repo's toolchain and usually has no Node.js
# and no npm. So pi is never installed into the base image. It is installed in a
# separate node stage, into a self-contained prefix, and copied in.
ARG BASE_IMAGE=node:lts-slim
# Node image used only to install pi. Override it for a musl base (node:lts-alpine).
ARG NODE_IMAGE=node:lts-slim

# Stage 1: install pi under /opt/pi, together with the node binary that runs it.
FROM ${NODE_IMAGE} AS pi
ARG PI_AGENT_VERSION
RUN test -n "$PI_AGENT_VERSION" \
 && npm install -g --prefix /opt/pi @mariozechner/pi-coding-agent@${PI_AGENT_VERSION} \
 && cp /usr/local/bin/node /opt/pi/bin/node

# Stage 2: graft that prefix onto the target base image. The base keeps its own
# toolchain untouched; /opt/pi/bin supplies both `pi` and the `node` its shebang
# needs. The node binary is glibc-linked, so glibc bases only.
FROM ${BASE_IMAGE}
COPY --from=pi /opt/pi /opt/pi
ENV PATH=/opt/pi/bin:$PATH
