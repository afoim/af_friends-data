'use strict';

const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

async function assertPublicUrl(raw, lookup = dns.lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Only public HTTP(S) URLs without credentials are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') && !host.includes(':')) throw new Error('Local hostnames are not allowed');
  if (/(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)) throw new Error('Local hostnames are not allowed');
  const addresses = ipaddr.isValid(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Non-public network destination is not allowed');
  return url.href;
}

module.exports = { isPublicAddress, assertPublicUrl };
