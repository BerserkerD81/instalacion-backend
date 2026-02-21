import AppDataSource, { initializeDataSource } from '../database/data-source';
import { InstallationRequest } from '../entities/InstallationRequest';
import { Technician } from '../entities/Technician';
import { SectorialNode } from '../entities/SectorialNode';
import { FileService } from './file.service';
import { DeepPartial, In, Not } from 'typeorm';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import logger from '../utils/logger';
import { wisphubConfig } from '../config';

// =========================================================================
// VARIABLES GLOBALES Y CONFIGURACIÓN (Compartidas por todos los servicios)
// =========================================================================
const BROWSER_WS = process.env.BROWSER_WS_ENDPOINT || 'ws://browser:3000';
const GEONET_BASE_URL = 'https://admin.geonet.cl';

// Cache de cookies en memoria para compartir la sesión entre servicios
let cachedCookies: any[] | null = null;
let cookiesTimestamp: number = 0;

// =========================================================================
// TIPOS E INTERFACES
// =========================================================================
type InstallationRequestInput = DeepPartial<InstallationRequest> & {
  idFront?: Buffer | string | null;
  idBack?: Buffer | string | null;
  addressProof?: Buffer | string | null;
  coupon?: Buffer | string | null;
};

type GeonetTicketInput = {
  ticketCategoryId: number;
  fechaInicio?: string;
  fechaFinal?: string;
  tecnicoId?: string;
  tecnico?: string; 
  tecnicoName?: string;
  asunto?: string;
  descripcion?: string;
  emailTecnico?: string;
  origenReporte?: string;
  estado?: string | number;
  prioridad?: string | number;
  asuntosDefault?: string;
  departamentosDefault?: string;
  departamento?: string;
  archivoTicket?: Buffer | string | null;
  fecha_inicio?: string; 
  fecha_final?: string;  
};

type WisphubTicketUpdateInput = {
  asuntosDefault?: string;
  asuntos_default?: string;
  asunto?: string;
  tecnico?: string;
  tecnicoId?: string;
  tecnicoName?: string;
  descripcion?: string;
  estado?: string | number;
  prioridad?: string | number;
  servicio?: string | number;
  fechaInicio?: string;
  fecha_inicio?: string;
  fechaFinal?: string;
  fecha_final?: string;
  origenReporte?: string;
  origen_reporte?: string;
  departamento?: string;
  emailTecnico?: string;
  email_tecnico?: string;
  archivoTicket?: Buffer | null;
};

type SelectOption = { value: string; text: string; title?: string; dataEmail?: string };

export type GeonetImportOptions = {
  loginUrl: string;
  dataPageUrl: string;
  onuPageUrl?: string;
  username?: string;
  password?: string;
};

// =========================================================================
// TABLAS DE CONVERSIÓN: SMARTOLT -> GEONET/WISPHUB
// =========================================================================
const AP_MAPPING: Record<string, string> = {
  "CTO 1 Z201 - Villa Maule": "CTO 1 Z201 - Villa Maule",
  "CTO 2 Z201 - Villa Maule": "CTO 2 Z201 - Villa Maule",
  "CTO1 - Torre 1- Z13": "CTO1 Z13 - Torre 1 - Brisas Las Rastras",
  "CTO1 - Z10 - Batallas de Lircay": "CTO1 Z10 - Batallas de Lircay",
  "CTO1 - Z11 - Batallas de Lircay": "CTO1 Z11 - Batallas de Lircay",
  "CTO1 - Z12 - Batallas de Lircay": "CTO1 Z12 - Batallas de Lircay",
  "CTO1 - Z203 -16": "CTO1 - Z203 (16)",
  "CTO1 - Z306 - Reserva San Miguel": "CTO 1 - Zona 306 - Reserva San Miguel",
  "CTO1 - Z401 - Parque del Sol": "CTO1 - Z401 - Parque del Sol",
  "CTO1 - Z402 - Parque del Sol": "CTO1 - Z402 - Parque del Sol",
  "CTO1 - Z403 - Parque del Sol": "CTO1 - Z403 - Parque del Sol",
  "CTO1 - Z404 - Parque del Sol": "CTO1 - Z404 - Parque del Sol",
  "CTO1 - Z406 - Valles de Linares": "CTO1 - Z406 - Valles de Linares",
  "CTO1 - Z407 - Dona Agustina IV": "CTO1 - Z407 - Doña Agustina IV",
  "CTO1 - Z9 - Batallas de Lircay": "CTO1 Z9 - Batallas de Lircay",
  "CTO1 - Zona 302 - Empresas 11 Oriente": "CTO1 - Zona 302 - Empresas 11 Oriente",
  "CTO1 Torre A - Z15 - Puertas de Lircay II": "CTO1 Torre A - Z15 - Puertas de Lircay II",
  "CTO1 Z202 - Villa Maule": "CTO1 Z202 - Villa Maule",
  "CTO1 Z204 - Dona Ignacia IX": "CTO1 - Z204 - Doña ignacia IX",
  "CTO1 Z205 - Dona Antonia V": "CTO1 Z205 - Doña Antonia V",
  "CTO1 Z3_16P": "CTO1 Z3",
  "CTO1 Z4_8P": "CTO1 Z4",
  "CTO1 Z7 Torre A_16P": "CTO1 Z7 Torre A (1-16)",
  "CTO1 Z8 Torre E_16P": "CTO1 Z8 Torre E (1-16)",
  "CTO1- Z14": "CTO1 - Z14",
  "CTO1-Z5_8P": "CTO1 Z5 1-8",
  "CTO1-Z6_8P": "CTO1 Z6 1-8",
  "CTO2  Z3_16P": "CTO2 Z3",
  "CTO2 - Torre 1- Z13": "CTO2 Z13 - Torre 1 - Brisas Las Rastras",
  "CTO2 - Z10 - Batallas de Lircay": "CTO2 Z10 - Batallas de Lircay",
  "CTO2 - Z11 - Batallas de Lircay": "CTO2 Z11 - Batallas de Lircay",
  "CTO2 - Z12 - Batallas de Lircay": "CTO2 Z12 - Batallas de Lircay",
  "CTO2 - Z203 -16": "CTO2 - Z203 (16)",
  "CTO2 - Z306 - Reserva San Miguel": "CTO 2 - Zona 306 - Reserva San Miguel",
  "CTO2 - Z401 - Parque del Sol": "CTO2 - Z401 - Parque del Sol",
  "CTO2 - Z402 - Parque del Sol": "CTO2 - Z402 - Parque del Sol",
  "CTO2 - Z403 - Parque del Sol": "CTO2 - Z403 - Parque del Sol",
  "CTO2 - Z404 - Parque del Sol": "CTO2 - Z404 - Parque del Sol",
  "CTO2 - Z406 - Valles de Linares": "CTO2 - Z406 - Valles de Linares",
  "CTO2 - Z407 - Dona Agustina IV": "CTO2 - Z407 - Doña Agustina IV",
  "CTO2 - Z9 - Batallas de Lircay": "CTO2 Z9 - Batallas de Lircay",
  "CTO2 - Zona 302 - Empresas 11 Oriente": "CTO2 - Zona 302 - Empresas 11 Oriente",
  "CTO2 Torre B - Z15 - Puertas de Lircay II": "CTO2 Torre B - Z15 - Puertas de Lircay II",
  "CTO2 Z202 - Villa Maule": "CTO2 Z202 - Villa Maule",
  "CTO2 Z204 - Dona Ignacia IX": "CTO2 - Z204 - Doña Ignacia IX",
  "CTO2 Z205 - Dona Antonia V": "CTO2 Z205 - Doña Antonia V",
  "CTO2 Z4_16P": "CTO2 Z4",
  "CTO2 Z7 Torre B_16P": "CTO2 Z7 Torre B (1-16)",
  "CTO2 Z8 Torre F_16P": "CTO2 Z8 Torre F (1-16)",
  "CTO2- Z14": "CTO2 - Z14",
  "CTO2-Z5_1-16": "CTO2 Z5 1-16",
  "CTO2-Z6_1-16": "CTO2 Z6 1-16",
  "CTO3  Z303 - Centro Comercial": "CTO3  Z303 - Centro Comercial",
  "CTO3 - Z10 - Batallas de Lircay": "CTO3 Z10 - Batallas de Lircay",
  "CTO3 - Z11 - Batallas de Lircay": "CTO3 Z11 - Batallas de Lircay",
  "CTO3 - Z12 - Batallas de Lircay": "CTO3 Z12 - Batallas de Lircay",
  "CTO3 - Z203 -16": "CTO3 - Z203 (16)",
  "CTO3 - Z306 - Reserva San Miguel": "CTO 3 - Zona 306 - Reserva San Miguel",
  "CTO3 - Z401 - Parque del Sol": "CTO3 - Z401 - Parque del Sol",
  "CTO3 - Z402 - Parque del Sol": "CTO3 - Z402 - Parque del Sol",
  "CTO3 - Z403 - Parque del Sol": "CTO3 - Z403 - Parque del Sol",
  "CTO3 - Z404 - Parque del Sol": "CTO3 - Z404 - Parque del Sol",
  "CTO3 - Z406 - Valles de Linares": "CTO3 - Z406 - Valles de Linares",
  "CTO3 - Z407 - Dona Agustina IV": "CTO3 - Z407 - Doña Agustina IV",
  "CTO3 - Z9 - Batallas de Lircay": "CTO3 Z9 - Batallas de Lircay",
  "CTO3 - Zona 302 - Empresas 11 Oriente": "CTO3 - Zona 302 - Empresas 11 Oriente",
  "CTO3 Torre C - Z15 - Puertas de Lircay II": "CTO3 Torre C - Z15 - Puertas de Lircay II",
  "CTO3 Z201 - Villa Maule": "CTO3 Z201 - Villa Maule",
  "CTO3 Z202 - Villa Maule": "CTO3 Z202 - Villa Maule",
  "CTO3 Z204 - Dona Ignacia IX": "CTO3 - Z204 - Doña Ignacia IX",
  "CTO3 Z205 - Dona Antonia V": "CTO3 Z205 - Doña Antonia V",
  "CTO3 Z3_16P": "CTO3 Z3",
  "CTO3 Z4": "CTO3 Z4",
  "CTO3 Z7 Torre C": "CTO3 Z7 Torre C (1-16)",
  "CTO3 Z8 Torre G": "CTO3 Z8 Torre G (1-16)",
  "CTO3- Torre 2- Z13": "CTO3 Z13 - Torre 2 - Brisas Las Rastras",
  "CTO3- Z14": "CTO3 - Z14",
  "CTO3-Z5_1-16": "CTO3 Z5 1-16",
  "CTO4  Z3": "CTO4 Z3",
  "CTO4 - Torre 2- Z13": "CTO4 Z13 - Torre 2 - Brisas Las Rastras",
  "CTO4 - Z10 - Batallas de Lircay": "CTO4 Z10 - Batallas de Lircay",
  "CTO4 - Z11 - Batallas de Lircay": "CTO4 Z11 - Batallas de Lircay",
  "CTO4 - Z12 - Batallas de Lircay": "CTO4 Z12 - Batallas de Lircay",
  "CTO4 - Z203 -16": "CTO4 - Z203 (16)",
  "CTO4 - Z306 - Reserva San Miguel": "CTO 4 - Zona 306 - Reserva San Miguel",
  "CTO4 - Z401 - Parque del Sol": "CTO4 - Z401 - Parque del Sol",
  "CTO4 - Z402 - Parque del Sol": "CTO4 - Z402 - Parque del Sol",
  "CTO4 - Z403 - Parque del Sol": "CTO4 - Z403 - Parque del Sol",
  "CTO4 - Z404 - Parque del Sol": "CTO4 - Z404 - Parque del Sol",
  "CTO4 - Z406 - Valles de Linares": "CTO4 - Z406 - Valles de Linares",
  "CTO4 - Z407 - Dona Agustina IV": "CTO4 - Z407 - Doña Agustina IV",
  "CTO4 - Z9 - Batallas de Lircay": "CTO4 Z9 - Batallas de Lircay",
  "CTO4 - Zona 302 - Empresas 11 Oriente": "CTO4 - Zona 302 - Empresas 11 Oriente",
  "CTO4 Torre D - Z15 - Puertas de Lircay II": "CTO4 Torre D - Z15 - Puertas de Lircay II",
  "CTO4 Z201 - Villa Maule": "CTO4 Z201 - Villa Maule",
  "CTO4 Z202 - Villa Maule": "CTO4 Z202 - Villa Maule",
  "CTO4 Z204 - Dona Ignacia IX": "CTO4 - Z204 - Doña Ignacia IX",
  "CTO4 Z205 - Dona Antonia V": "CTO4 Z205 - Doña Antonia V",
  "CTO4 Z4": "CTO4 Z4",
  "CTO4 Z7 Torre D": "CTO4 Z7 Torre D (1-16)",
  "CTO4 Z8 Torre H": "CTO4 Z8 Torre H (1-16)",
  "CTO4- Z14": "CTO4 - Z14",
  "CTO4-Z5_1-16": "CTO4 Z5 1-16",
  "CTO5 - Torre 3- Z13": "CTO5 Z13 - Torre 3 - Brisas Las Rastras",
  "CTO5 - Z11 - Batallas de Lircay": "CTO5 Z11 - Batallas de Lircay",
  "CTO5 - Z12 - Batallas de Lircay": "CTO5 Z12 - Batallas de Lircay",
  "CTO5 - Z203 -16": "CTO5 - Z203 (16)",
  "CTO5 - Z401 - Parque del Sol": "CTO5 - Z401 - Parque del Sol",
  "CTO5 - Z402 - Parque del Sol": "CTO5 - Z402 - Parque del Sol",
  "CTO5 - Z403 - Parque del Sol": "CTO5 - Z403 - Parque del Sol",
  "CTO5 - Z404 - Parque del Sol": "CTO5 - Z404 - Parque del Sol",
  "CTO5 - Z406 - Valles de Linares": "CTO5 - Z406 - Valles de Linares",
  "CTO5 - Z407 - Dona Agustina IV": "CTO5 - Z407 - Doña Agustina IV",
  "CTO5 - Zona 302 - Empresas 11 Oriente": "CTO5 - Zona 302 - Empresas 11 Oriente",
  "CTO5 Torre E - Z16 - Puertas de Lircay II": "CTO1 Torre E - Z16 - Puertas de Lircay II",
  "CTO5 Z14 - Valles de Talca II": "CTO5 Z14 - Valles de Talca",
  "CTO5 Z201 - Villa Maule": "CTO5 Z201 - Villa Maule",
  "CTO5 Z202 - Villa Maule": "CTO5 Z202 - Villa Maule",
  "CTO5 Z204 - Dona Ignacia IX": "CTO5 - Z204 - Doña Ignacia IX",
  "CTO5 Z4": "CTO5 Z4",
  "CTO5- Z306 - Reserva San Miguel": "CTO 5 - Zona 306 - Reserva San Miguel",
  "CTO6 - Torre 3- Z13": "CTO6 Z13 - Torre 3 - Brisas Las Rastras",
  "CTO6 - Z203 -16": "CTO6 - Z203 (16)",
  "CTO6 - Z306 - Reserva San Miguel": "CTO 6 - Zona 306 - Reserva San Miguel",
  "CTO6 - Z401 - Parque del Sol": "CTO6 - Z401 - Parque del Sol",
  "CTO6 - Z402 - Parque del Sol": "CTO6 - Z402 - Parque del Sol",
  "CTO6 - Z403 - Parque del Sol": "CTO6 - Z403 - Parque del Sol",
  "CTO6 - Z404 - Parque del Sol": "CTO6 - Z404 - Parque del Sol",
  "CTO6 - Z406 - Valles de Linares": "CTO6 - Z406 - Valles de Linares",
  "CTO6 - Z407 - Dona Agustina IV": "CTO6 - Z407 - Doña Agustina IV",
  "CTO6 - Zona 302 - Empresas 11 Oriente": "CTO6 - Zona 302 - Empresas 11 Oriente",
  "CTO6 Torre F - Z16 - Puertas de Lircay II": "CTO2 Torre F - Z16 - Puertas de Lircay II",
  "CTO6 Z14 - Valles de Talca II": "CTO6 Z14 - Valles de Talca.",
  "CTO6 Z201 - Villa Maule": "CTO6 Z201 - Villa Maule",
  "CTO6 Z202 - Villa Maule": "CTO6 Z202 - Villa Maule",
  "CTO6 Z204 - Dona Ignacia IX": "CTO6 - Z204 - Dona Ignacia IX",
  "CTO6 Z4 _8P": "CTO6 Z4",
  "CTO7 - Z203 -16": "CTO7 - Z203 (1x16)",
  "CTO7 - Z401 - Parque del Sol": "CTO7 - Z401 - Parque del Sol",
  "CTO7 - Z402 - Parque del Sol": "CTO7 - Z402 - Parque del Sol",
  "CTO7 - Z403 - Parque del Sol": "CTO7 - Z403 - Parque del Sol",
  "CTO7 - Z404 - Parque del Sol": "CTO7 - Z404 - Parque del Sol",
  "CTO7 - Z406 - Valles de Linares": "CTO7 - Z406 - Valles de Linares",
  "CTO7 - Z407 - Dona Agustina IV": "CTO7 - Z407 - Doña Agustina IV",
  "CTO7 Torre G - Z16 - Puertas de Lircay II": "CTO3 Torre G - Z16 - Puertas de Lircay II",
  "CTO7 Z201 - Villa Maule": "CTO7 Z201 - Villa Maule",
  "CTO7 Z202 - Villa Maule": "CTO7 Z202 - Villa Maule",
  "CTO7 Z204 - Dona Ignacia IX": "CTO7 - Z204 - Dona Ignacia IX",
  "CTO7 Z4": "CTO7 Z4",
  "CTO7- Torre 4- Z13": "CTO7 Z13 - Torre 4 - Brisas Las Rastras",
  "CTO8 - Torre 4- Z13": "CTO8 Z13 - Torre 4 - Brisas Las Rastras",
  "CTO8 - Z203 -16": "CTO8 - Z203 (16)",
  "CTO8 - Z401 - Parque del Sol": "CTO8 - Z401 - Parque del Sol",
  "CTO8 - Z402 - Parque del Sol": "CTO8 - Z402 - Parque del Sol",
  "CTO8 - Z403 - Parque del Sol": "CTO8 - Z403 - Parque del Sol",
  "CTO8 - Z404 - Parque del Sol": "CTO8 - Z404 - Parque del Sol",
  "CTO8 - Z406 - Valles de Linares": "CTO8 - Z406 - Valles de Linares",
  "CTO8 - Z407 - Dona Agustina IV": "CTO8 - Z407 - Doña Agustina IV",
  "CTO8 Torre H - Z16 - Puertas de Lircay II": "CTO4 Torre H - Z16 - Puertas de Lircay II",
  "CTO8 Z201 - Villa Maule": "CTO8 Z201 - Villa Maule",
  "CTO8 Z202 - Villa Maule": "CTO8 Z202 - Villa Maule",
  "CTO8 Z204 - Dona Ignacia IX": "CTO8 - Z204 - Dona Ignacia IX",
  "CTO9 - Z404 - Parque del Sol": "CTO9 - Z404 - Parque del Sol",
  "CTO9 - Z407 - Dona Agustina IV": "CTO9 - Doña Agustina IV - Zona 407",
  "ODF1 - Centro Comercial Alto Las Rastras": "ODF1 Z301 - Centro Comercial Alto Las Rastras. -",
  "ODF1 Z303 - Hacienda Esmeralda lll": "ODF1 Zona 303 - Edificio Hacienda Eseralda III",
  "ODF1 Z304 - Centro Comercial Casa Boulevard": "ODF3 Z304 - Centro Comercial Casa Boulevard",
  "ODF1 Z305 -Centro Comercial Paseo Hacienda SOTI": "ODF2 - Z305 - Centro Comercial Paseo Hacienda",
  "ODF2 Z303 - Hacienda Esmeralda lll": "ODF1 Zona 303 - Edificio Hacienda Eseralda III",
  "ODF2 Z304 - Centro Comercial Casa Boulevard": "ODF3 Z304 - Centro Comercial Casa Boulevard",
  "ODF2 Z305 -Centro Comercial Paseo Hacienda ASOTEA": "ODF2 - Z305 - Centro Comercial Paseo Hacienda",
  "ODF3 Z304 - Centro Comercial Casa Boulevard": "ODF3 Z304 - Centro Comercial Casa Boulevard",
  "Spliter 1 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 1 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 1 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 1 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 2 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 2 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 2 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 2 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 3 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 3 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 3 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 3 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 4 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 4 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 4 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 4 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 5 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 5 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 5 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 5 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 6 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 6 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 6 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 6 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 7 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 7 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 7 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 7 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 8 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 8 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 8 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 8 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Torre1 - CTO1 - Z405 - Parque del Sol 5": "Torre1 - CTO1 - Z405 - Parque del Sol 5",
  "Torre1 - CTO2 - Z405 - Parque del Sol 5": "Torre1 - CTO2- Z405 - Parque del Sol 5",
  "Torre2  - CTO2- Z405 - Parque del Sol 5": "Torre1 - CTO2- Z405 - Parque del Sol 5",
  "Torre2- CTO1 - Z405 - Parque del Sol 5": "Torre1 - CTO1 - Z405 - Parque del Sol 5",
  "Torre3 - CTO1 - Z405 - Parque del Sol 5": "Torre1 - CTO1 - Z405 - Parque del Sol 5",
  "Torre3 - CTO2 - Z405 - Parque del Sol 5": "Torre1 - CTO2- Z405 - Parque del Sol 5"
};

const ZONE_MAPPING: Record<string, string> = {
  "Villa Maule - Z201": "Villa Maule - Zona 201 - Vlan 201",
  "Brisas las Rastras - Z13": "Brisas Las Rastras - Zona 13 - Vlan 112",
  "Batallas de Lircay - Z10": "Batallas de Lircay - Zona 10 - Vlan 109",
  "Batallas de Lircay - Z11": "Batallas de Lircay - Zona 11 - Vlan 110",
  "Batallas de Lircay - Z12": "Batallas de Lircay - Zona 12 - Vlan 111",
  "Portal Maule - Z203": "Portal II Maule - Zona 203 - Vlan 203",
  "Reserva San Miguel - Zona 306 - Vlan 306": "Reserva San Miguel - Zona 306 - Vlan 306",
  "Parque de Sol - Z401": "Parque del Sol - Zona 401 - Vlan 401",
  "Parque de Sol - Z402": "Parque del Sol - Zona 402 - Vlan 402",
  "Parque de Sol - Z403": "Parque del Sol - Zona 403 - Vlan 403",
  "Parque de Sol 4 - Z404": "Parque del Sol 4 - Zona 404 - Vlan 404",
  "Valles de Linares - Z406": "Valles de Linares - Zona 406 - Vlan 406",
  "Dona Agustina IV - Z407": "Doña Agustina IV - Zona 407 - Vlan 407",
  "Batallas de Lircay - Z9": "Batallas de Lircay - Zona 9 - Vlan 108",
  "Empresas 11 Oriente - Z302": "Empresas 11 Oriente - Zona 302 - Vlan 302",
  "Puertas de Lircay II - Torre A-D - Zona 15 - Vlan 114": "Puertas de Lircay II - Zona 15 - Vlan 114",
  "Villa Maule - Z202": "Villa Maule - Zona 202 - Vlan 202",
  "Dona Ignacia IX - Zona 204 - Vlan 204": "Doña Ignacia IX - Zona 204 - Vlan 204",
  "Dona Antonia V - Zona 205 - Vlan 205": "Doña Antonia V - Zona 205 - Vlan 205",
  "Bicentenario Talca 3 Z3 ODF17": "Centro Comercial Alto Las Rastras - Zona 301 - Vlan 301.-",
  "Bicentenario Talca 3 Z4 ODF18": "Villa Bicentenario 3 Calle K, K' - Zona 4 - Vlan 103",
  "Puerta de Lircay 1 Torres A-D- Zona 7 - Vlan 106": "Puerta de Lircay 1 Torres A-D- Zona 7 - Vlan 106",
  "Puerta de Lircay 1 Torres E-H- Zona 8 - Vlan 107": "Puerta de Lircay 1 Torres E-H- Zona 8 - Vlan 107",
  "Valles de Talca - Z14": "Valles de Talca II - Zona 14 - Vlan 113",
  "Parque_San_Valentin-Z5": "Parque San Valentin - Zona 5 - Vlan 104",
  "Parque_San_Valentin-Z6": "Parque San Valentin - Zona 6 - Vlan 105",
  "Edificio Hacienda Esmeralda lll - Z303": "Edificio Hacienda Esmeralda III - Zona 303 - Vlan 303",
  "Puertas de Lircay II - Torre E-H - Zona 16 - Vlan 115": "Puertas de Lircay II - Zona 16 - Vlan 115",
  "Alto Las Rastras - Z301": "Centro Comercial Alto Las Rastras - Zona 301 - Vlan 301.-",
  "Centro Comercial Casa Boulevard  - Z304 - Vlan 304": "Centro Comercial Casa Boulevard - Zona 304 - Vlan 304",
  "Centro Comercial Paseo Hacienda - Z305 - Vlan 305": "Centro Comercial Pase Hacienda - Zona 305 - Vlan 305",
  "Mirador Urbano A-B": "Condominio Mirador Urbano Torre A y B - Vlan100",
  "Mirador Urbano C-D": "Condominio Mirador Urbano Torre A y B - Vlan100",
  "Parque de Sol 5- Z405": "Parque del Sol 5 - Zona 405 - Vlan 405"
};

// =========================================================================
// CLASE BASE: GEONET BROWSER SERVICE (Manejo de Sesión y Cloudflare)
// =========================================================================
export class GeonetBaseService {
  
  protected async getBrowser(): Promise<Browser> {
    if ((global as any).__sharedBrowser) {
      try { return (global as any).__sharedBrowser as Browser; } catch {}
    }

    const MAX_ATTEMPTS = 3;
    let lastErr: any = null;
    
    // Timeout elevado a 120s para soportar retos lentos
    const timeout = 120000;
    const wsUrl = `${BROWSER_WS}${BROWSER_WS.includes('?') ? '&' : '?'}stealth=true&timeout=${timeout}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        logger.info(`[GeonetBase] Conectando a Browserless (intento ${attempt})...`);
        const browser = await puppeteer.connect({
          browserWSEndpoint: wsUrl,
          defaultViewport: { width: 1920, height: 1080 }
        });

        // Hacemos que disconnect sea no-op para reutilizar la conexión
        (browser as any).__realDisconnect = (browser as any).disconnect?.bind(browser) || null;
        (browser as any).disconnect = async () => { /* noop: conexión compartida */ };

        (global as any).__sharedBrowser = browser;
        return browser;
      } catch (err: any) {
        lastErr = err;
        logger.warn(`[GeonetBase] Error conectando: ${err.message}. Reintentando...`);
        await new Promise(res => setTimeout(res, 1000 * attempt));
      }
    }
    throw new Error(`No se pudo conectar a Browserless: ${lastErr?.message}`);
  }

  public async shutdownBrowser(): Promise<void> {
    const shared = (global as any).__sharedBrowser as Browser | undefined;
    if (!shared) return;
    try {
      const real = (shared as any).__realDisconnect;
      if (real) await real();
    } catch (e: any) {
      logger.warn('[GeonetBase] Error cerrando browser:', e?.message);
    }
    (global as any).__sharedBrowser = null;
  }

  protected async openPage(): Promise<{ browser: Browser; page: Page }> {
    let browser = await this.getBrowser();
    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(60000); 

      try {
        await page.setRequestInterception(true);
        // Bloqueamos multimedia para ahorrar ancho de banda
        const blockedResourceTypes = new Set(['image', 'font', 'media']); 
        page.on('request', (req) => {
          try {
            if (blockedResourceTypes.has(req.resourceType())) return req.abort();
            return req.continue();
          } catch (e) {
            try { req.continue(); } catch (_) {}
          }
        });
      } catch (e) {}

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'es-CL,es-419;q=0.9,es;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      });

      return { browser, page };
    } catch (err: any) {
      logger.warn('[GeonetBase] newPage falló, reconectando...', err?.message);
      try { await this.shutdownBrowser(); } catch (e) {}
      browser = await this.getBrowser();
      const page = await browser.newPage();
      return { browser, page };
    }
  }

  protected async ensureSession(page: Page, opts?: { force?: boolean }): Promise<boolean> {
    const start = Date.now();
    try {
      if (page.isClosed()) return false;

      const isCookieFresh = (Date.now() - cookiesTimestamp) < 1000 * 60 * 45; // 45 min
      if (!opts?.force && cachedCookies && cachedCookies.length > 0 && isCookieFresh) {
        await page.setCookie(...cachedCookies);
        return true;
      }

      logger.info('[GeonetBase] Cookies no válidas o expiradas. Iniciando Login...');
      
      const response = await page.goto(`${GEONET_BASE_URL}/accounts/login/`, { 
        waitUntil: 'networkidle2', 
        timeout: 90000 
      });

      if (response) {
        const status = response.status();
        if (status === 429) {
          logger.error('⚠️ ALERTA: Status 429 (Too Many Requests). IP bloqueada temporalmente por Geonet.');
        } else if (status === 403) {
          logger.error('⚠️ ALERTA: Status 403 (Forbidden). Cloudflare bloqueó el acceso directo.');
        }
      }

      // Evasión Cloudflare Turnstile
      const isCloudflare = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('just a moment') || text.includes('verifying') || !!document.querySelector('#cf-challenge') || window.location.href.includes('__cf_chl_rt_tk');
      });

      if (isCloudflare) {
        logger.warn('⚠️ Cloudflare Detectado. Aplicando contramedidas (Mouse jiggling)...');
        try {
          await page.mouse.move(100, 100);
          await page.mouse.move(200, 200, { steps: 10 });
          await page.mouse.move(150, 300, { steps: 20 });
        } catch (e) {}

        try {
          await page.waitForFunction(() => {
            return !document.body.innerText.toLowerCase().includes('verifying') && !!document.querySelector('input[name="login"]');
          }, { timeout: 30000 });
          logger.info('✅ Cloudflare evadido con éxito.');
        } catch (e) {
          const htmlDump = await page.evaluate(() => document.body.innerText.substring(0, 400).replace(/\n/g, ' | '));
          logger.error(`❌ Fallo al superar Cloudflare. Texto en pantalla: [${htmlDump}]`);
          return false;
        }
      }

      try {
        await page.waitForSelector('input[name="login"]', { timeout: 15000 });
      } catch (error) {
        const currentUrl = page.url();
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 400).replace(/\n/g, ' | '));
        logger.error(`❌ No se encontró el formulario de login. URL: ${currentUrl} | DUMP: ${bodyText}`);
        return false;
      }

      const username = process.env.GEONET_USER || process.env.ADMIN_LOGIN || 'Jorgeprac@geonet';
      const password = process.env.GEONET_PASS || process.env.ADMIN_PASSWORD || 'JorgePrac';

      await page.click('input[name="login"]', { clickCount: 3 });
      await page.type('input[name="login"]', username, { delay: 75 });
      await page.click('input[name="password"]', { clickCount: 3 });
      await page.type('input[name="password"]', password, { delay: 75 });

// 1. Usar domcontentloaded es mejor para formularios
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        page.click('button[type="submit"]')
      ]);

      // 2. Pequeña pausa para asegurar que Django renderizó el error si lo hay
      await new Promise(res => setTimeout(res, 2000));

      const finalUrl = page.url();
      if (!finalUrl.includes('/accounts/login/') && !finalUrl.includes('__cf_chl_rt_tk')) {
        cachedCookies = await page.cookies();
        cookiesTimestamp = Date.now();
        logger.info(`✅ Login exitoso y cookies guardadas. T: ${Date.now() - start}ms`);
        return true;
      }
      
      // 3. CAPTURAR EL ERROR EXACTO DE LA PANTALLA
      const errorMsg = await page.evaluate(() => {
        // Busca las clases típicas de error en Django/Geonet
        const alert = document.querySelector('.alert, .errorlist, .text-danger, .help-block');
        return alert ? alert.textContent?.trim() : 'Ningún mensaje de error visible';
      });

      logger.error(`❌ Geonet rechazó las credenciales. Mensaje en pantalla: "${errorMsg}"`);
      return false;} catch (err: any) {
      logger.error(`Error en ensureSession: ${err.message}`);
      return false;
    }
  }

  protected async safeGoto(page: Page, url: string, opts?: { waitForSelector?: string; timeout?: number }): Promise<any> {
    const timeout = opts?.timeout ?? 45000;
    let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    
    if (page.url().includes('/accounts/login/')) {
      logger.info('[GeonetBase] Redirigido a Login inesperadamente. Re-autenticando...');
      const ok = await this.ensureSession(page, { force: true });
      if (!ok) throw new Error('No se pudo autenticar en Geonet');
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    }
    
    if (opts?.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 15000 }).catch(() => null);
    }
    return response;
  }

  protected async ensureDataSource(): Promise<void> {
    if (!AppDataSource.isInitialized) {
      await initializeDataSource();
    }
  }
}

// =========================================================================
// 1. SERVICIO DE IMPORTACIÓN (Hereda de GeonetBaseService)
// =========================================================================
export class GeonetImportService extends GeonetBaseService {
  
  public async importFromGeonet(opts: GeonetImportOptions): Promise<void> {
    await this.ensureDataSource();
    const { browser, page } = await this.openPage();

    try {
      const loggedIn = await this.ensureSession(page);
      if (!loggedIn) throw new Error('No se pudo iniciar sesión en Geonet');

      if (opts.dataPageUrl) {
        await this.safeGoto(page, opts.dataPageUrl);
        const html = await page.content();
        await this.importSectorials(html, opts.dataPageUrl);
      }
      
      if (opts.onuPageUrl) {
        await this.safeGoto(page, opts.onuPageUrl);
        const html = await page.content();
        await this.importOnus(html, opts.onuPageUrl);
      }
    } catch (error: any) {
      logger.error(`Error crítico en importación: ${error.message}`);
    } finally {
      await page.close(); // No cerramos el browser para mantener la sesión viva
    }
  }

  private clean(val: any) { return val ? String(val).trim() : null; }
  private cleanNum(val: any) {
    if (!val) return 0;
    const num = parseInt(String(val).replace(/\D/g, ''), 10);
    return isNaN(num) ? 0 : num;
  }

  private parseHtmlTable(html: string): any[] {
    const $ = cheerio.load(html);
    const records: any[] = [];
    const headers: string[] = [];
    
    $('table thead tr th').each((i, el) => {
      let text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!text) text = `col_${i}`;
      headers.push(text);
    });

    $('table tbody tr').each((i, row) => {
      const record: any = {};
      $(row).find('td').each((j, cell) => {
        const header = headers[j];
        if (header && !header.startsWith('col_')) {
            record[header] = $(cell).text().replace(/\n/g, '').trim();
        }
      });
      if (Object.keys(record).length > 0) records.push(record);
    });

    return records;
  }

  private async importSectorials(html: string, url: string) {
    logger.info(`Analizando HTML de Sectoriales desde: ${url}`);
    const records = this.parseHtmlTable(html);
    
    if (records.length === 0) {
        logger.warn('Tabla vacía o no detectada. No se realizaron cambios en la BD.');
        return;
    }

    logger.info(`Procesando ${records.length} sectoriales...`);
    const repo = AppDataSource.getRepository(SectorialNode);
    const processedNames: string[] = [];
    let count = 0;

    for (const row of records) {
        const entity = new SectorialNode();
        const getVal = (keyPart: string) => {
            const realKey = Object.keys(row).find(k => k.toLowerCase().includes(keyPart.toLowerCase()));
            return realKey ? row[realKey] : null;
        };

        entity.nombre = this.clean(getVal('Nombre')) ?? ''; 
        entity.tipo = this.clean(getVal('Tipo'));
        entity.ip = this.clean(getVal('Ip'));
        entity.usuario = this.clean(getVal('Usuario'));
        entity.password = this.clean(getVal('Password'));
        entity.zona = this.clean(getVal('Zona')); 
        entity.coordenadas = this.clean(getVal('Coordenadas')); 
        entity.totalClientes = this.cleanNum(getVal('Total de Clientes'));
        entity.ssid = this.clean(getVal('SSID'));
        entity.frecuencias = this.clean(getVal('Frecuencia'));
        entity.nodoTorre = this.clean(getVal('Nodo/Torre'));
        entity.comentarios = this.clean(getVal('Comentarios'));
        entity.accion = this.clean(getVal('Acción'));
        entity.fallaGeneral = (getVal('Falla General') === 'Si' || getVal('Falla') === 'Si') ? 'Si' : 'No';

        if (entity.nombre) {
            processedNames.push(entity.nombre); 
            const existing = await repo.findOne({ where: { nombre: entity.nombre } });
            if (existing) {
                repo.merge(existing, entity);
                await repo.save(existing);
            } else {
                await repo.save(entity);
            }
            count++;
        }
    }

    if (processedNames.length > 0) {
        const deleteResult = await repo.delete({ nombre: Not(In(processedNames)) });
        if (deleteResult.affected && deleteResult.affected > 0) {
            logger.info(`Limpieza: Se eliminaron ${deleteResult.affected} sectoriales antiguos.`);
        }
    }
    logger.info(`Sectoriales: ${count} sincronizados correctamente.`);
  }

  private async importOnus(html: string, url: string) {
    logger.info(`Analizando HTML de ONUs desde: ${url}`);
    try {
        const records = this.parseHtmlTable(html);
        if (records.length === 0) return;
        let count = 0;
        for (const row of records) {
            const serial = row['Serial'] || row['MAC'] || row['Mac Address'];
            if (serial) count++;
        }
        logger.info(`ONUs: ${count} detectadas (Simulación).`);
    } catch (err: any) {
        logger.error(`Error importando ONUs: ${err.message}`);
    }
  }
}

// =========================================================================
// 2. SERVICIO DE INSTALACIÓN Y TICKETS (Hereda de GeonetBaseService)
// =========================================================================
export class InstallationService extends GeonetBaseService {
  private fileService = new FileService();

  private async extractSelectOptions(page: Page, selector: string): Promise<SelectOption[]> {
    return page.evaluate((sel) => {
      const select = document.querySelector(sel) as HTMLSelectElement;
      if (!select) return [];
      return Array.from(select.options).map(opt => ({
        value: opt.value,
        text: opt.textContent?.trim() || '',
        title: opt.getAttribute('title') || '',
        dataEmail: opt.getAttribute('data-email') || opt.getAttribute('data-tecnico-email') || ''
      }));
    }, selector);
  }

  // --- GEONET ACTIVACIÓN ---
  public async lookupPreinstallationActivation(params: {
    clientName: string;
    technicianName: string;
    planName?: string;
    installationRequestId?: number;
    zonaName?: string;
    routerName?: string;
    apName?: string;
    comments?: string;
    agreedInstallationDate?: string | Date;
  }): Promise<{
    activationLink: string;
    technicianId: string;
    planId: string;
    firstAvailableIp: string | null;
    activationPostStatus?: number;
  }> {
    const { clientName, technicianName, planName, installationRequestId, agreedInstallationDate } = params;
    let effectivePlanName = planName;
    let resolvedRequestId = installationRequestId;
    let resolvedRequest: InstallationRequest | null = null;

    if (resolvedRequestId === undefined) {
      resolvedRequestId = await this.findInstallationRequestIdByClientName(clientName);
    }

    if (resolvedRequestId !== undefined) {
      resolvedRequest = await this.findInstallationRequestById(resolvedRequestId);
      if (resolvedRequest?.plan) effectivePlanName = resolvedRequest.plan;
    }

    if (resolvedRequest && !resolvedRequest.agreedInstallationDate && agreedInstallationDate) {
      try {
        await this.ensureDataSource();
        const repo = AppDataSource.getRepository(InstallationRequest);
        const parsed = new Date(String(agreedInstallationDate));
        if (!Number.isNaN(parsed.getTime())) {
          resolvedRequest.agreedInstallationDate = parsed;
          await repo.save(resolvedRequest as any);
        }
      } catch (e) {}
    }

    if (resolvedRequestId === undefined || !resolvedRequest) {
      throw Object.assign(new Error('No se encontró la InstallationRequest en la BD'), { statusCode: 404 });
    }

    if (!effectivePlanName) {
      throw Object.assign(new Error('planName no encontrado'), { statusCode: 400 });
    }

    const { browser, page } = await this.openPage();
    try {
      if (!await this.ensureSession(page)) throw new Error('Auth falló');

      await this.safeGoto(page, `${GEONET_BASE_URL}/preinstalaciones/`);

      const targetTokens = this.normalizeText(clientName).split(' ').filter(Boolean);

      const activationLink = await page.evaluate((tokens) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const row of rows) {
          const rowText = (row.textContent || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (tokens.length === 0 || tokens.every((t: string) => rowText.includes(t))) {
            const a = row.querySelector('a[href*="/preinstalacion/activar/"]');
            if (a) return (a as HTMLAnchorElement).href;
          }
        }
        return null;
      }, targetTokens);

      if (!activationLink) throw Object.assign(new Error('No se encontró enlace de activación'), { statusCode: 404 });

      await this.safeGoto(page, activationLink);

      const techOptions = await this.extractSelectOptions(page, 'select[name*="tecnico" i], select[id*="tecnico" i]');
      const planOptions = await this.extractSelectOptions(page, 'select[name*="plan" i], select[id*="plan" i]');
      
      const firstAvailableIp = await page.evaluate(() => {
        const ipNode = document.querySelector('#popover-ips-disponibles ul li a');
        if (ipNode && ipNode.textContent) {
          const match = ipNode.textContent.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
          if (match) return match[0];
        }
        const textContentMatches = document.body.textContent?.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        return textContentMatches[0] || null;
      });

      const technicianId = this.findOptionIdObj(techOptions, technicianName);
      const planId = this.findOptionIdObj(planOptions, effectivePlanName);

      if (!technicianId) throw Object.assign(new Error('No se encontró técnico'), { statusCode: 404 });
      if (!planId) throw Object.assign(new Error('No se encontró plan'), { statusCode: 404 });

      const activationPostStatus = await this.submitGeonetActivation({
        ...params,
        page,
        activationLink,
        technicianId,
        planId,
        firstAvailableIp,
        installationRequestId: resolvedRequestId,
      });

      return { activationLink, technicianId, planId, firstAvailableIp, activationPostStatus };
    } finally {
      await page.close();
    }
  }

  private async submitGeonetActivation(params: {
    page: Page;
    activationLink: string;
    technicianId: string;
    planId: string;
    firstAvailableIp: string | null;
    installationRequestId: number;
    zonaName?: string;
    routerName?: string;
    apName?: string;
    comments?: string;
  }): Promise<number> {
    const { page, activationLink, technicianId, planId, firstAvailableIp, installationRequestId, zonaName, routerName, apName } = params;

    if (!firstAvailableIp) throw Object.assign(new Error('No se encontró una IP disponible'), { statusCode: 404 });

    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(InstallationRequest);
    const request = await repo.findOne({ where: { id: installationRequestId } });
    if (!request) throw Object.assign(new Error('InstallationRequest no encontrada'), { statusCode: 404 });
    if (!request.agreedInstallationDate) throw Object.assign(new Error('agreedInstallationDate es requerido'), { statusCode: 400 });

    const routerOptions = await this.extractSelectOptions(page, 'select[name*="router_cliente" i]');
    const zonaOptions = await this.extractSelectOptions(page, 'select[name*="zona_cliente" i]');
    const apOptions = await this.extractSelectOptions(page, 'select[name*="ap_cliente" i]');

    let routerValue = '';
    let zonaValue = '';
    let apValue = '';

    const extractScopeLetters = (s: string): string[] => {
      const clean = s.toLowerCase();
      const letters: Set<string> = new Set();
      const rangeMatch = clean.match(/\b([a-d])\s*[-]\s*([a-d])\b/);
      if (rangeMatch) {
        for (let i = rangeMatch[1].charCodeAt(0); i <= rangeMatch[2].charCodeAt(0); i++) letters.add(String.fromCharCode(i));
      }
      const specificMatches = clean.matchAll(/(?:torre|block|edificio|sector)s?\s*([a-z](?:\s*y\s*[a-z])?)/g);
      for (const m of specificMatches) {
        if (m[1]) m[1].split(/\s*y\s*/).forEach(p => letters.add(p.trim()));
      }
      if (!/\d/.test(clean)) {
         const endMatch = clean.match(/\b([a-z])[-]([a-z])\b/);
         if (endMatch) {
            for (let i = endMatch[1].charCodeAt(0); i <= endMatch[2].charCodeAt(0); i++) letters.add(String.fromCharCode(i));
         }
      }
      return Array.from(letters);
    };

    const getStrictName = (s: string) => {
        return s.toLowerCase()
          .replace(/(?:zona|z|vlan)\s*[-:._]?\s*(\d+)(?:[-_]\d+p)?/g, '') 
          .replace(/(?:cto|nap|odf|spliter|splitter)\s*[-:._]?\s*(\d+)/g, '')
          .replace(/(?:torre|edificio|block|sector)\s*[-:._]?\s*([a-z0-9]+)/g, '')
          .replace(/\b(de|del|el|la|los|las|y|en|ii|iii|iv|v|ix)\b/g, '')
          .replace(/[-:._()]/g, ' ')
          .replace(/\s+/g, ' ').trim();
    };

    if (routerName && routerOptions.length > 0) {
      routerValue = this.findOptionIdObj(routerOptions, String(routerName));
      if (!routerValue) routerValue = routerOptions.find(o => !o.text.includes('---------'))?.value || '';
    }

    if (zonaOptions.length > 0) {
      if (zonaName && String(zonaName).trim()) {
        const mappedTarget = ZONE_MAPPING[String(zonaName).trim()] || String(zonaName).trim();
        const directMatch = zonaOptions.find(o => o.text.trim().toLowerCase() === mappedTarget.toLowerCase());
        
        if (directMatch) {
            zonaValue = directMatch.value;
        } else {
            const extractZoneId = (s: string) => s.match(/(?:zona|z|vlan)\s*[-:._]?\s*(\d+)/i)?.[1];
            const targetId = extractZoneId(mappedTarget);
            const targetTokens = getStrictName(mappedTarget).split(' ').filter(x => x.length > 2);
            let bestZoneValue = '';
            let bestZoneScore = -1;

            zonaOptions.forEach(opt => {
              if (!opt.value || opt.text.includes('---------')) return;
              const optId = extractZoneId(opt.text);
              const optCleanName = getStrictName(opt.text);

              if (targetId && optId && targetId !== optId) return;
              let score = 0;
              targetTokens.forEach(t => { if (optCleanName.includes(t)) score += 500; });
              if (targetId && optId && targetId === optId) score += 1000;
              if (score > bestZoneScore) { bestZoneScore = score; bestZoneValue = opt.value; }
            });
            zonaValue = bestZoneScore >= 100 ? bestZoneValue : (zonaOptions.find(o => !o.text.includes('---------'))?.value || '');
        }
      } else {
        zonaValue = zonaOptions.find(o => !o.text.includes('---------'))?.value || '';
      }
    }

    if (apOptions.length > 0) {
      if (apName && String(apName).trim()) {
        const mappedTarget = AP_MAPPING[String(apName).trim()] || String(apName).trim();
        const directMatch = apOptions.find(o => o.text.trim().toLowerCase() === mappedTarget.toLowerCase());

        if (directMatch) {
            apValue = directMatch.value;
        } else {
            const extractMeta = (s: string) => ({
               zone: s.match(/(?:zona|z|vlan)\s*[-:._]?\s*(\d+)/i)?.[1],
               cto: s.match(/(?:cto|nap|odf|spliter|splitter)\s*[-:._]?\s*(\d+)/i)?.[1],
               tower: s.match(/(?:torre|edificio|block)\s*[-:._]?\s*([a-z0-9]+)/i)?.[1]?.toLowerCase()
            });

            const tMeta = extractMeta(mappedTarget);
            const tTokens = getStrictName(mappedTarget).split(' ').filter(x => x.length > 2);
            let bestApValue = '';
            let bestApScore = -1;

            apOptions.forEach(opt => {
              if (!opt.value || opt.text.includes('---------')) return;
              const oMeta = extractMeta(opt.text);
              const oCleanName = getStrictName(opt.text);

              if (tTokens.length > 0 && !tTokens.some(t => oCleanName.includes(t))) return;
              if (tMeta.zone && oMeta.zone && tMeta.zone !== oMeta.zone) return;
              if (tMeta.cto && oMeta.cto && tMeta.cto !== oMeta.cto) return;

              let score = 1000;
              tTokens.forEach(t => { if (oCleanName.includes(t)) score += 100; });
              if (tMeta.tower && oMeta.tower && tMeta.tower === oMeta.tower) score += 500;
              if (tMeta.cto && oMeta.cto && tMeta.cto === oMeta.cto) score += 300;

              if (score > bestApScore) { bestApScore = score; bestApValue = opt.value; }
            });
            apValue = bestApScore >= 1000 ? bestApValue : (apOptions.find(o => !o.text.includes('---------'))?.value || '');
        }
      } else {
        apValue = apOptions.find(o => !o.text.includes('---------'))?.value || '';
      }
    }

    const fullName = `${request.firstName || ''} ${request.lastName || ''}`.trim();
    const activationId = this.getActivationIdFromUrl(activationLink);
    const firstNameSlug = (request.firstName || '').split(/\s+/).filter(Boolean)[0]?.toLowerCase().replace(/\s+/g, '_') || '';
    const externalIdBase = activationId ? `${activationId}_${firstNameSlug}` : `${request.id}_${firstNameSlug}`;
    const ciNormalized = this.normalizeCedula(request.ci || '');
    const phoneValue = request.additionalPhone ? `${request.phone || ''},${request.additionalPhone}` : `${request.phone || ''}`;
    const commentsToSend = params.comments !== undefined && params.comments !== null ? String(params.comments) : (request.comments || '');

    const result = await page.evaluate(async (args) => {
      try {
        const csrf = (document.querySelector('input[name="csrfmiddlewaretoken"]') as HTMLInputElement)?.value || '';
        const formParams = new URLSearchParams();
        const formFields = args.formFields as Record<string, string>;
        Object.entries(formFields).forEach(([k, v]) => formParams.append(k, v));
        formParams.set('csrfmiddlewaretoken', csrf);

        const res = await fetch(args.activationLink, {
          method: 'POST',
          body: formParams.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf },
          redirect: 'manual'
        });

        return { status: res.status, url: res.url };
      } catch (err: any) {
        return { status: 500, error: err.toString() };
      }
    }, {
      activationLink,
      formFields: {
        'usr-first_name': request.firstName || '',
        'usr-last_name': request.lastName || '',
        'perfil-cedula': ciNormalized,
        'usr-email': request.email || '',
        'perfil-direccion': request.address || '',
        'perfil-external_id': externalIdBase,
        'cliente-coordenadas': request.coordinates || '',
        'perfil-localidad': request.neighborhood || '',
        'perfil-ciudad': request.city || '',
        'perfil-telefono': phoneValue,
        'cliente-fecha_registro': this.formatDateTimeCL(request.createdAt),
        'cliente-fecha_instalacion': this.formatDateTimeCL(request.agreedInstallationDate),
        'cliente-costo_instalacion': '0',
        'cliente-comentarios': commentsToSend,
        'cliente-cliente_rb': externalIdBase,
        'cliente-ip': firstAvailableIp,
        'cliente-router_cliente': routerValue,
        'cliente-zona_cliente': zonaValue,
        'cliente-plan_internet': planId,
        'cliente-tecnico': technicianId,
        'cliente-estado_instalacion': '1',
        'cliente-ap_cliente': apValue,
        'usr-password': '{dni_cliente}',
        'cliente-external_id': externalIdBase,
        'perfil-nombre_facturacion': fullName,
        'perfil-tipo_persona': '2',
        'perfil-tipo_identificacion': '0',
        'perfil-rfc': ciNormalized,
        'perfil-cp': request.postalCode || '',
        'perfil-direccion_facturacion': request.address || '',
        'perfil-email_facturacion': request.email || '',
        'perfil-representante_legal': fullName,
        'perfil-cedula_facturacion': ciNormalized,
        'perfil-retenciones': '0.00',
        'perfil-retencion_iva': '19.0'
      }
    });

    return result.status;
  }

  // --- GEONET TICKETS ---
public async crearTicket(params: GeonetTicketInput): Promise<any> {
    const start = Date.now();
    const { browser, page } = await this.openPage();

    try {
      // 1. Validar la sesión
      if (!await this.ensureSession(page)) throw new Error('Auth falló');

      const ticketUrl = `${GEONET_BASE_URL}/tickets/agregar/${params.ticketCategoryId}/`;
      logger.info(`[Puppeteer] Creando ticket en: ${ticketUrl}`);

      // 2. Ir a la URL del formulario y esperar que renderice
      await this.safeGoto(page, ticketUrl, { waitForSelector: 'form#agregar-ticket' });

      // Normalizar nombres de variables (Soporta camelCase de la interfaz y snake_case de n8n)
      const effectiveInicio = params.fecha_inicio || params.fechaInicio;
      const effectiveFinal = params.fecha_final || params.fechaFinal;
      const effectiveTecnicoId = params.tecnicoId || (params as any).tecnico;

      // 3. Llenar campos Select y de texto estándar
      
      // ASUNTO
      const asuntoDefaultStr = params.asuntosDefault || (params as any).asuntos_default || 'Instalación';
      await page.select('#id_asuntos_default', asuntoDefaultStr);
      
      // Manejar el caso donde el select despliega un input adicional
      if (asuntoDefaultStr === 'Otro Asunto' && params.asunto) {
        await page.waitForSelector('#id_asunto', { visible: true });
        await page.type('#id_asunto', params.asunto);
      }

      // TÉCNICO
      if (effectiveTecnicoId) {
        await page.select('#id_tecnico', String(effectiveTecnicoId));
      }

      // DEPARTAMENTO (Solo interactuamos con el select visible, la página llena el oculto sola)
      const departamentoSelectStr = params.departamentosDefault || (params as any).departamentos_default || 'Otro';
      await page.select('#id_departamentos_default', departamentoSelectStr);

      // ORIGEN, ESTADO Y PRIORIDAD
      const origenStr = params.origenReporte || (params as any).origen_reporte || 'oficina';
      await page.select('#id_origen_reporte', origenStr);

      if (params.estado) await page.select('#id_estado', String(params.estado));
      if (params.prioridad) await page.select('#id_prioridad', String(params.prioridad));

      // 4. Llenar fechas (inyectando el valor directamente para evadir bloqueos del datepicker)
      if (effectiveInicio) {
        await page.evaluate((val) => { 
          (document.querySelector('#id_fecha_inicio') as HTMLInputElement).value = val; 
        }, effectiveInicio);
      }
      if (effectiveFinal) {
        await page.evaluate((val) => { 
          (document.querySelector('#id_fecha_final') as HTMLInputElement).value = val; 
        }, effectiveFinal);
      }

      // 5. Inyectar contenido en CKEditor (El editor de texto enriquecido)
      const descripcion = params.descripcion || 'Ticket automático vía Bot';
      await page.evaluate((texto) => {
        // Interaccionar directamente con la API global de CKEditor
        if ((window as any).CKEDITOR && (window as any).CKEDITOR.instances.id_descripcion) {
          (window as any).CKEDITOR.instances.id_descripcion.setData(texto);
        } else {
          // Fallback por si CKEditor fallara en cargar
          (document.querySelector('#id_descripcion') as HTMLTextAreaElement).value = texto;
        }
      }, descripcion);

      // 6. Hacer clic en Guardar y esperar a que el backend nos redirija
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('button[type="submit"].btn-primary')
      ]);

      // 7. Comprobar éxito
      const finalUrl = page.url();
      // Si el form fue exitoso, Django hace un redirect (HTTP 302) y salimos de la URL de "/agregar/"
      const isSuccess = !finalUrl.includes('/agregar/'); 
      
      logger.info(`[Puppeteer] Ticket creado, isSuccess: ${isSuccess}, URL final: ${finalUrl}, t: ${Date.now() - start}ms`);

      // Devolvemos status 200 en caso de éxito, 400 si se quedó atascado en el formulario
      return { status: isSuccess ? 200 : 400, location: finalUrl };

    } catch (error: any) {
      logger.error(`Error en crearTicket: ${error.message}`);
      throw error;
    } finally {
      // Siempre cerrar la página para liberar RAM del contenedor de Browserless
      await page.close();
    }
  }

  public async eliminarTicketGeonet(params: { ticketId: string | number }): Promise<any> {
    const { browser, page } = await this.openPage();
    try {
      if (!await this.ensureSession(page)) throw new Error('Auth falló');
      await this.safeGoto(page, `${GEONET_BASE_URL}/tickets/eliminar/${params.ticketId}/`);
      
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('button[type="submit"], input[type="submit"]')
      ]);
      return { status: 200, location: page.url() };
    } finally {
      await page.close();
    }
  }

  public async editarInstalacionGeonet(params: { externalIdOrUser: string; installationId: string | number; updates: Record<string, any>; }): Promise<any> {
    const { externalIdOrUser, installationId, updates } = params;
    if (!externalIdOrUser || !installationId) throw Object.assign(new Error('externalIdOrUser e installationId son requeridos'), { statusCode: 400 });

    const { browser, page } = await this.openPage();
    try {
      if (!await this.ensureSession(page)) throw new Error('Auth falló');

      const url = `${GEONET_BASE_URL}/Instalaciones/editar/${encodeURIComponent(externalIdOrUser)}/${encodeURIComponent(installationId)}/`;
      await this.safeGoto(page, url, { waitForSelector: 'form' });

      const result = await page.evaluate(async (args) => {
        try {
          const formEl = document.querySelector('form') as HTMLFormElement;
          if (!formEl) return { status: 502, error: 'No form found' };

          const formData = new window.FormData(formEl);
          const csrf = (document.querySelector('input[name="csrfmiddlewaretoken"]') as HTMLInputElement)?.value || '';
          formData.set('csrfmiddlewaretoken', csrf);

          const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-_\s]+/g, '');
          const baseKeys = Array.from(formData.keys());

          const recordUpdates = args.updates as Record<string, any>;
          for (const [key, value] of Object.entries(recordUpdates)) {
            if (value === undefined || value === null || key === 'csrfmiddlewaretoken') continue;
            let targetKey = key;
            if (!formData.has(key)) {
              const nk = normalize(key);
              const candidate = baseKeys.find(bk => normalize(String(bk)).includes(nk));
              if (candidate) targetKey = String(candidate);
            }
            formData.set(targetKey, String(value));
          }

          const res = await fetch(args.url, { method: 'POST', body: formData, redirect: 'manual' });
          let effectiveStatus = res.status;
          if (res.status === 302 && res.headers.get('location')?.includes('/Instalaciones')) effectiveStatus = 200;

          return { status: effectiveStatus, url: res.url };
        } catch (e: any) {
          return { status: 500, error: e.toString() };
        }
      }, { updates: updates || {}, url });

      return { status: result.status, location: result.url };
    } finally {
      await page.close();
    }
  }

  public async eliminarInstalacionGeonet(params: { externalId: string }): Promise<any> {
    const { browser, page } = await this.openPage();
    try {
      if (!await this.ensureSession(page)) throw new Error('Auth falló');
      await this.safeGoto(page, `${GEONET_BASE_URL}/Instalaciones/eliminar/${encodeURIComponent(params.externalId)}/`);
      
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('button[type="submit"], input[type="submit"]')
      ]);
      return { status: 200, location: page.url() };
    } finally {
      await page.close();
    }
  }

  // =========================================================================
  // API WISPHUB Y AXIOS (Mantenido con API de Axios original)
  // =========================================================================

  public async getAllRequests(): Promise<InstallationRequest[]> {
    await this.ensureDataSource();
    return await AppDataSource.getRepository(InstallationRequest).find();
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 1000): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return await fn(); } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (![429, 502, 503, 504].includes(status) || attempt === attempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
      }
    }
    throw lastError;
  }

  public async listWisphubStaff(params: { limit?: number; offset?: number; }): Promise<any> {
    const origin = 'https://api.wisphub.app';
    const u = new URL(`${origin}/api/staff/`);
    if (params.limit) u.searchParams.set('limit', String(params.limit));
    if (params.offset) u.searchParams.set('offset', String(params.offset));

    const response = await this.withRetry(() => axios.get(u.toString(), {
      headers: { Authorization: `Api-Key ${wisphubConfig.apiKey}` }
    }));
    return { status: response.status, data: response.data };
  }

  public async createRequest(data: InstallationRequestInput): Promise<InstallationRequest> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(InstallationRequest);
    const wisphubResult = await this.notifyWisphub(data as any);
    if (!wisphubResult || (wisphubResult.status !== null && wisphubResult.status >= 400)) {
        throw new Error('Wisphub error');
    }
    return repo.save(repo.create(data as any) as any);
  }

  private appendFile(form: FormData, field: string, fileName: string | null): void {
    if (!fileName) return;
    const filePath = this.fileService.getFilePath(fileName);
    if (fs.existsSync(filePath)) {
      form.append(field, fs.createReadStream(filePath) as any, fileName);
    }
  }

  private async notifyWisphub(request: InstallationRequest): Promise<{ status: number | null; data: any; skipped?: boolean }> {
    const { apiUrl, apiKey } = wisphubConfig;
    if (!apiUrl || !apiKey) return { status: null, data: null, skipped: true };

    const form = new FormData();
    form.append('firstname', request.firstName || '');
    form.append('lastname', request.lastName || '');
    form.append('dni', request.ci || '');
    form.append('address', request.address || '');
    form.append('phone_number', request.phone || '');
    form.append('email', request.email || '');
    form.append('location', request.neighborhood || '');
    form.append('city', request.city || '');
    form.append('postal_code', request.postalCode || '');
    form.append('aditional_phone_number', request.additionalPhone || '');
    form.append('commentaries', request.comments || '');
    form.append('coordenadas', request.coordinates || '');

    this.appendFile(form, 'front_dni_proof', request.idFront as string | null);
    this.appendFile(form, 'back_dni_proof', request.idBack as string | null);
    this.appendFile(form, 'proof_of_address', request.addressProof as string | null);
    this.appendFile(form, 'discount_coupon', request.coupon as string | null);

    try {
      const response = await axios.post(apiUrl, form, {
        headers: { ...form.getHeaders(), Authorization: `Api-Key ${apiKey}` },
      });
      return { status: response.status, data: response.data };
    } catch (err: any) {
      return { status: err?.response?.status ?? null, data: err?.response?.data };
    }
  }

  private getWisphubTicketsUrl(): string {
    const { apiUrl } = wisphubConfig;
    try {
      const u = new URL(apiUrl);
      return `${u.origin}/api/tickets/`;
    } catch {
      return 'https://api.wisphub.app/api/tickets/';
    }
  }

  private getWisphubTicketDetailUrl(ticketId: string | number): string {
    const base = this.getWisphubTicketsUrl();
    const id = String(ticketId).trim();
    if (!id) return base;
    return base.endsWith('/') ? `${base}${encodeURIComponent(id)}/` : `${base}/${encodeURIComponent(id)}/`;
  }

  private async resolveWisphubStaffByName(params: { staffName: string; apiKey: string; maxPages?: number; limit?: number; }): Promise<{ id: string; nombre: string; email?: string } | null> {
    const { staffName, apiKey, maxPages = 20, limit = 50 } = params;
    const target = this.normalizeText(String(staffName || ''));
    if (!target) return null;

    let nextUrl: string | null = `https://api.wisphub.app/api/staff/?limit=${limit}&offset=0`;
    let pages = 0;
    let best: { id: string; nombre: string; email?: string; score: number } | null = null;

    while (nextUrl && pages < maxPages) {
      pages += 1;
      const resp = await axios.get(nextUrl, { headers: { Authorization: `Api-Key ${apiKey}` }, validateStatus: () => true });
      if (resp.status >= 300) return null;
      const data: any = resp.data;
      const results: any[] = Array.isArray(data?.results) ? data.results : [];

      for (const item of results) {
        const id = item?.id ? String(item.id).trim() : '';
        const nombre = item?.nombre ? String(item.nombre).trim() : '';
        if (!id || !nombre) continue;

        const normalized = this.normalizeText(nombre);
        const score = this.calculateSimilarityScore(target, normalized);
        if (normalized === target) return { id, nombre, email: item.email };
        if (!best || score > best.score) best = { id, nombre, email: item.email, score };
      }
      nextUrl = data?.next || null;
    }
    return best && best.score >= 0.6 ? { id: best.id, nombre: best.nombre, email: best.email } : null;
  }

  private async resolveWisphubTechnicianIdByName(params: { technicianName: string; apiKey: string; maxPages?: number; }): Promise<string> {
    const staff = await this.resolveWisphubStaffByName({ staffName: params.technicianName, apiKey: params.apiKey, maxPages: params.maxPages });
    return staff?.id ?? '';
  }

  public async findWisphubTicketIdByClientFullName(params: { clientFullName: string; maxPages?: number; }): Promise<{ idTicket: string | null; matches: Array<{ idTicket: string; servicioNombre: string }>; scanned: number; pages: number; }> {
    const { clientFullName, maxPages = 10 } = params;
    const { apiKey } = wisphubConfig;
    const target = this.normalizeText(String(clientFullName || ''));

    if (!target) throw Object.assign(new Error('clientFullName es requerido'), { statusCode: 400 });
    if (!apiKey) throw Object.assign(new Error('Wisphub API config missing'), { statusCode: 500 });

    let nextUrl: string | null = this.getWisphubTicketsUrl();
    let pages = 0;
    let scanned = 0;
    const matches: Array<{ idTicket: string; servicioNombre: string }> = [];

    while (nextUrl && pages < maxPages) {
      pages += 1;
      const response = await this.withRetry(() => axios.get(nextUrl as string, { headers: { Authorization: `Api-Key ${apiKey}` }, validateStatus: () => true }));
      if (response.status >= 300) throw Object.assign(new Error(`Wisphub error ${response.status}`), { statusCode: 502 });

      const data: any = response.data;
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      scanned += results.length;

      for (const item of results) {
        const servicioNombre = String(item?.servicio?.nombre || '');
        if (!servicioNombre) continue;
        const normalized = this.normalizeText(servicioNombre);

        if (normalized.includes(target) || target.includes(normalized)) {
          const idCandidate = item?.id_ticket ?? item?.idTicket ?? item?.id ?? null;
          if (idCandidate !== null) matches.push({ idTicket: String(idCandidate), servicioNombre });
        }
      }
      nextUrl = data?.next || null;
    }

    return { idTicket: matches[0]?.idTicket ?? null, matches, scanned, pages };
  }

  public async editarTicketWisphub(params: { ticketId: string | number; updates: WisphubTicketUpdateInput; }): Promise<any> {
    const { ticketId, updates } = params;
    const { apiKey } = wisphubConfig;
    if (!apiKey) throw Object.assign(new Error('Wisphub API config missing'), { statusCode: 500 });

    const detailUrl = this.getWisphubTicketDetailUrl(ticketId);
    const form = new FormData();
    const sentFields: string[] = [];

    const append = (key: string, val: any) => {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        form.append(key, String(val).trim());
        sentFields.push(key);
      }
    };

    append('asuntos_default', updates.asuntos_default ?? updates.asuntosDefault);
    append('asunto', updates.asunto);
    append('descripcion', updates.descripcion);
    append('estado', updates.estado);
    append('prioridad', updates.prioridad);
    append('servicio', updates.servicio);
    append('fecha_inicio', updates.fecha_inicio ?? updates.fechaInicio);
    append('fecha_final', updates.fecha_final ?? updates.fechaFinal);
    append('origen_reporte', updates.origen_reporte ?? updates.origenReporte);
    append('departamento', updates.departamento);
    append('email_tecnico', updates.email_tecnico ?? updates.emailTecnico);

    let tecnicoId = updates.tecnico ?? updates.tecnicoId;
    if (!tecnicoId && updates.tecnicoName) {
      tecnicoId = await this.resolveWisphubTechnicianIdByName({ technicianName: updates.tecnicoName, apiKey });
    }
    append('tecnico', tecnicoId);

    if (updates.archivoTicket && Buffer.isBuffer(updates.archivoTicket)) {
      form.append('archivo_ticket', updates.archivoTicket as any, { filename: 'archivo_ticket.bin' } as any);
      sentFields.push('archivo_ticket');
    }

    const response = await axios.request({
      method: 'patch',
      url: detailUrl,
      data: form,
      headers: { ...form.getHeaders(), Authorization: `Api-Key ${apiKey}` },
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    return { status: response.status, data: response.data, sentFields, method: 'PATCH', url: detailUrl };
  }

  // =========================================================================
  // UTILS Y HELPERS DE TEXTO
  // =========================================================================

  private normalizeText(value: string): string {
    return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }

  private normalizeCedula(value: string): string {
    let s = String(value || '').replace(/\./g, '').trim();
    if (/-k$/i.test(s)) s = s.replace(/-k$/i, '-K');
    return s;
  }

  private extractNumericTokens(value: string): string[] {
    return value ? (value.match(/\d+/g) || []) : [];
  }

  private calculateSimilarityScore(target: string, candidate: string): number {
    if (!target || !candidate) return 0;
    if (candidate.includes(target)) return 1;

    const targetTokens = new Set(target.split(' ').filter(Boolean));
    const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
    if (targetTokens.size === 0 || candidateTokens.size === 0) return 0;

    let overlap = 0;
    for (const token of targetTokens) {
      if (candidateTokens.has(token)) overlap += 1;
    }
    return overlap / new Set([...targetTokens, ...candidateTokens]).size;
  }

  private findOptionIdObj(options: SelectOption[], optionName: string): string {
    const target = this.normalizeText(optionName);
    const targetNumbers = this.extractNumericTokens(target);
    let bestValue = '';
    let bestScore = 0;

    const targetIsEmail = String(optionName || '').includes('@');
    const extractTowerLetter = (s: string) => s.match(/torre\s*[:#\-]?\s*([A-Za-z0-9])/i)?.[1]?.toLowerCase() || '';
    const targetTower = extractTowerLetter(optionName);
    const locationTokens = ['mirador', 'condominio', 'brisas', 'edificio', 'spliter'];

    for (const opt of options) {
      const normalizedText = this.normalizeText(opt.text);
      if (targetIsEmail) {
        const combined = `${normalizedText} ${opt.title} ${opt.dataEmail} ${opt.value}`.toLowerCase();
        if (combined.includes(target)) return opt.value;
      }

      let score = this.calculateSimilarityScore(target, normalizedText);
      if (targetNumbers.length > 0) {
        const candidateNumbers = this.extractNumericTokens(normalizedText);
        if (targetNumbers.filter((n) => candidateNumbers.includes(n)).length > 0) score += 0.4;
      }

      const candTower = extractTowerLetter(opt.text);
      if (targetTower && candTower && targetTower === candTower) score += 0.6;

      const locationShared = locationTokens.filter((k) => target.includes(k) && normalizedText.includes(k)).length;
      if (locationShared > 0) {
        score += locationShared * 0.6;
        if (/\bcto\b/.test(normalizedText)) score -= 0.25;
      }

      if (score > bestScore) {
        bestScore = score;
        bestValue = opt.value;
      }
    }
    return bestValue;
  }

  private formatDateTimeCL(value: Date | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private getActivationIdFromUrl(url: string): string | null {
    return url.match(/\/activar\/[^/]+\/(\d+)\/?$/)?.[1] ?? null;
  }

  private async findInstallationRequestIdByClientName(clientName: string): Promise<number | undefined> {
    await this.ensureDataSource();
    const repo = AppDataSource.getRepository(InstallationRequest);
    const req = await repo.createQueryBuilder('r')
        .where('LOWER(CONCAT(r.firstName, " ", r.lastName)) LIKE :name', { name: `%${clientName.toLowerCase()}%` })
        .getOne();
    return req?.id;
  }

  private async findInstallationRequestById(id: number): Promise<InstallationRequest | null> {
    await this.ensureDataSource();
    return AppDataSource.getRepository(InstallationRequest).findOne({ where: { id } });
  }
}