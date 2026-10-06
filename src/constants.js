const SERVICE_TYPES = {
  missed_pickup: {
    label: 'Missed Pickup (Comeback)',
    short: 'Comeback',
    icon: 'rotate',
    blurb: 'A door was missed or a resident set out late. We send a valet back.',
    tone: 'red',
  },
  valet_trash: {
    label: 'Doorstep Valet Trash',
    short: 'Valet Trash',
    icon: 'trash',
    blurb: 'Start, pause, or change nightly doorstep trash & recycling collection.',
    tone: 'navy',
  },
  bulk_removal: {
    label: 'Bulk Item Removal',
    short: 'Bulk Removal',
    icon: 'truck',
    blurb: 'Furniture, mattresses, boxes, and abandoned items hauled away.',
    tone: 'amber',
  },
  common_area: {
    label: 'Common Area Cleanup',
    short: 'Common Area',
    icon: 'sparkles',
    blurb: 'Lobbies, hallways, stairwells, mailrooms, laundry & amenity spaces.',
    tone: 'teal',
  },
  pet_station: {
    label: 'Pet Waste Stations',
    short: 'Pet Stations',
    icon: 'paw',
    blurb: 'Empty, sanitize, and restock pet waste stations across the grounds.',
    tone: 'green',
  },
  enclosure: {
    label: 'Dumpster & Compactor Area',
    short: 'Enclosure',
    icon: 'container',
    blurb: 'Clean overflow, debris, and spills around dumpsters and compactors.',
    tone: 'slate',
  },
  trash_out: {
    label: 'Unit Trash-Out',
    short: 'Trash-Out',
    icon: 'door',
    blurb: 'Move-out and eviction clean-outs so units are turn-ready faster.',
    tone: 'purple',
  },
  other: {
    label: 'Other / Special Request',
    short: 'Special',
    icon: 'clipboard',
    blurb: 'Post-event cleanup, storm debris, or anything else you need.',
    tone: 'slate',
  },
};

const STATUSES = {
  submitted: { label: 'Submitted', tone: 'info', icon: 'inbox' },
  scheduled: { label: 'Scheduled', tone: 'navy', icon: 'calendar' },
  dispatched: { label: 'Crew Dispatched', tone: 'amber', icon: 'send' },
  in_progress: { label: 'In Progress', tone: 'amber', icon: 'clock' },
  completed: { label: 'Completed', tone: 'success', icon: 'check' },
  cancelled: { label: 'Cancelled', tone: 'muted', icon: 'x' },
};

const PRIORITIES = {
  standard: 'Standard',
  urgent: 'Urgent (same / next day)',
};

const FREQUENCIES = {
  one_time: 'One time',
  weekly: 'Weekly',
  biweekly: 'Every other week',
  monthly: 'Monthly',
};

const WINDOWS = [
  'Morning (8 AM – 12 PM)',
  'Afternoon (12 PM – 5 PM)',
  'Evening (6 PM – 10 PM)',
  'Any time',
];

const NIGHTS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ROLES = {
  client: 'Property Client',
  admin: 'Administrator',
  supervisor: 'Field Supervisor',
  technician: 'Service Technician',
};

const COMPANY = {
  name: 'Valor Valet',
  legalName: 'Valor Valet Waste & Common Area Care, LLC',
  tagline: 'Doorstep valet trash & common area care for multifamily communities',
  phone: '(800) 555-0142',
  email: 'service@valorvalet.com',
  serviceArea: 'Serving apartment & multifamily communities nationwide',
};

module.exports = { SERVICE_TYPES, STATUSES, PRIORITIES, FREQUENCIES, WINDOWS, NIGHTS, ROLES, COMPANY };
