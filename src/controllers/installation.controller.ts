import { Request, Response } from 'express';
import { InstallationService } from '../services/installation.service';
import logger from '../utils/logger';

export class InstallationController {
  private installationService: InstallationService;

  constructor() {
    this.installationService = new InstallationService();
  }

  public async createInstallationRequest(req: Request, res: Response): Promise<Response> {
    try {
      const data = req.body;

      // Normalizar arrays que llegan como string en form-data
      if (typeof data.installationDates === 'string') {
        try {
          // soporta JSON stringified array o CSV
          const trimmed = data.installationDates.trim();
          data.installationDates = trimmed.startsWith('[')
            ? JSON.parse(trimmed)
            : trimmed.split(',').map((s: string) => s.trim()).filter(Boolean);
        } catch {
          data.installationDates = data.installationDates
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
        }
      }

      // Procesar archivos si existen
      if (req.files) {
        const files = req.files as any;
        if (files.idFront) data.idFront = files.idFront[0].buffer;
        if (files.idBack) data.idBack = files.idBack[0].buffer;
        if (files.addressProof) data.addressProof = files.addressProof[0].buffer;
        if (files.coupon) data.coupon = files.coupon[0].buffer;
      }

      const installationRequest = await this.installationService.createRequest(data);
      return res.status(201).json(installationRequest);
    } catch (error: any) {
      logger.error(`Error creating installation request: ${String(error)}`);
      if (error.isWisphubError) {
        const status = error.status || 400;
        // forward Wisphub response body to client
        return res.status(status).json(error.data);
      }
      return res.status(500).json({ message: 'Error creating installation request' });
    }
  }

  public async getInstallationRequests(req: Request, res: Response): Promise<Response> {
    try {
      const requests = await this.installationService.getAllRequests();
      return res.status(200).json(requests);
    } catch (error) {
      logger.error(`Error retrieving installation requests: ${String(error)}`);
      return res.status(500).json({ message: 'Error retrieving installation requests' });
    }
  }

  public async lookupPreinstallation(req: Request, res: Response): Promise<Response> {
    try {
      const { clientName, technicianName, planName, installationRequestId, agreedInstallationDate } = req.body ?? {};
      if (!clientName || !technicianName) {
        return res
          .status(400)
          .json({ message: 'clientName y technicianName son obligatorios' });
      }

      const zonaName = (req.body && (req.body.zona ?? req.body.zone ?? req.body.zona_cliente)) ?? undefined;
      const routerName = (req.body && (req.body.router ?? req.body.sectorial ?? req.body.router_cliente)) ?? undefined;
      const apName = (req.body && (
        req.body.ap ?? req.body.nap ?? req.body.ap_cliente ?? req.body.nap_cliente ?? req.body.sectorial ?? req.body.sectorial_nap
      )) ?? undefined;

      const result = await this.installationService.lookupPreinstallationActivation({
        clientName: String(clientName),
        technicianName: String(technicianName),
        planName: planName !== undefined && planName !== null && String(planName).trim() !== ''
          ? String(planName)
          : undefined,
        installationRequestId:
          installationRequestId !== undefined && installationRequestId !== null
            ? Number(installationRequestId)
            : undefined,
        agreedInstallationDate:
          agreedInstallationDate !== undefined && agreedInstallationDate !== null
            ? String(agreedInstallationDate)
            : undefined,
        zonaName: zonaName !== undefined && zonaName !== null ? String(zonaName) : undefined,
        routerName: routerName !== undefined && routerName !== null ? String(routerName) : undefined,
        apName: apName !== undefined && apName !== null ? String(apName) : undefined,
      });

      return res.status(200).json(result);
    } catch (error: any) {
      logger.error(`Error looking up preinstallation: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message || 'Error en búsqueda de preinstalación' });
    }
  }

  public async crearTicket(req: Request, res: Response): Promise<Response> {
    try {
      const body: any = req.body ?? {};
      const ticketCategoryIdRaw = req.params.ticketCategoryId ?? body.ticketCategoryId ?? body.ticket_category_id;
      const ticketCategoryId = Number(ticketCategoryIdRaw);
      if (!Number.isFinite(ticketCategoryId)) {
        return res
          .status(400)
          .json({ message: 'ticketCategoryId inválido (en URL o body; debe ser número)' });
      }

      const fechaInicio = body.fechaInicio ?? body.fecha_inicio;
      const fechaFinal = body.fechaFinal ?? body.fecha_final;
      const tecnicoId = body.tecnicoId ?? body.tecnico;
      const tecnicoName = body.tecnicoName ?? body.technicianName ?? body.tecnico_nombre;

      if (!fechaInicio || !fechaFinal || (!tecnicoId && !tecnicoName)) {
        return res.status(400).json({
          message:
            'Campos requeridos: fechaInicio/fecha_inicio, fechaFinal/fecha_final, y (tecnicoId/tecnico o tecnicoName/technicianName)',
        });
      }

      const archivoTicketBuffer = (req as any).file?.buffer as Buffer | undefined;

      const result = await this.installationService.crearTicket({
        ticketCategoryId,
        fechaInicio: String(fechaInicio),
        fechaFinal: String(fechaFinal),
        tecnicoId: tecnicoId !== undefined && tecnicoId !== null ? String(tecnicoId) : undefined,
        tecnicoName: tecnicoName !== undefined && tecnicoName !== null ? String(tecnicoName) : undefined,
        asunto: body.asunto !== undefined ? String(body.asunto) : undefined,
        descripcion: body.descripcion !== undefined ? String(body.descripcion) : undefined,
        emailTecnico: body.emailTecnico ?? body.email_tecnico,
        origenReporte: body.origenReporte ?? body.origen_reporte,
        estado: body.estado !== undefined ? body.estado : undefined,
        prioridad: body.prioridad !== undefined ? body.prioridad : undefined,
        asuntosDefault: body.asuntosDefault ?? body.asuntos_default,
        departamentosDefault: body.departamentosDefault ?? body.departamentos_default,
        departamento: body.departamento !== undefined ? String(body.departamento) : undefined,
        archivoTicket: archivoTicketBuffer ?? null,
      });

      // Geonet often responds with HTML even on validation errors; surface as 422.
      const hasValidationErrors =
        (result.formErrors && result.formErrors.length > 0) ||
        (result.missingRequiredFields && result.missingRequiredFields.length > 0);

      const isOk = result.status >= 200 && result.status < 400;
      if (isOk && hasValidationErrors) {
        return res.status(422).json(result);
      }

      return res.status(isOk ? 200 : 502).json(result);
    } catch (error: any) {
      logger.error(`Error creating Geonet ticket: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message || 'Error creando ticket' });
    }
  }

  public async eliminarTicketGeonet(req: Request, res: Response): Promise<Response> {
    try {
      const ticketIdRaw: any = req.params.ticketId ?? req.params.id;
      const ticketId = String(ticketIdRaw ?? '').trim();
      if (!ticketId) {
        return res.status(400).json({ message: 'ticketId es requerido en la URL' });
      }

      const result = await this.installationService.eliminarTicketGeonet({ ticketId });

      const isOk = result.status >= 200 && result.status < 400;
      const hasValidationErrors = result.formErrors && result.formErrors.length > 0;
      if (isOk && hasValidationErrors) {
        return res.status(422).json(result);
      }

      return res.status(isOk ? 200 : 502).json(result);
    } catch (error: any) {
      logger.error(`Error deleting Geonet ticket: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message || 'Error eliminando ticket', data: error.data });
    }
  }

  public async editarTicketWisphub(req: Request, res: Response): Promise<Response> {
    try {
      const ticketId = String(req.params.ticketId ?? '').trim();
      if (!ticketId) {
        return res.status(400).json({ message: 'ticketId es requerido en la URL' });
      }

      const body: any = req.body ?? {};
      const archivoTicketBuffer = (req as any).file?.buffer as Buffer | undefined;

      const result = await this.installationService.editarTicketWisphub({
        ticketId,
        updates: {
          asuntosDefault: body.asuntosDefault ?? body.asuntos_default,
          asuntos_default: body.asuntos_default,
          asunto: body.asunto,
          tecnico: body.tecnico ?? body.tecnicoId,
          tecnicoId: body.tecnicoId,
          tecnicoName: body.tecnicoName ?? body.technicianName,
          descripcion: body.descripcion,
          estado: body.estado,
          prioridad: body.prioridad,
          servicio: body.servicio,
          fechaInicio: body.fechaInicio ?? body.fecha_inicio,
          fecha_inicio: body.fecha_inicio,
          fechaFinal: body.fechaFinal ?? body.fecha_final,
          fecha_final: body.fecha_final,
          origenReporte: body.origenReporte ?? body.origen_reporte,
          origen_reporte: body.origen_reporte,
          departamento: body.departamento,
          emailTecnico: body.emailTecnico ?? body.email_tecnico,
          email_tecnico: body.email_tecnico,
          archivoTicket: archivoTicketBuffer ?? null,
        },
      });

      const isOk = result.status >= 200 && result.status < 300;
      return res.status(isOk ? 200 : 502).json(result);
    } catch (error: any) {
      logger.error(`Error editing Wisphub ticket: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message || 'Error editando ticket Wisphub', data: error.data });
    }
  }

  public async buscarTicketWisphubPorCliente(req: Request, res: Response): Promise<Response> {
    try {
      const q: any = req.query ?? {};
      const clientFullName = q.nombre ?? q.clientName ?? q.clientFullName;
      const maxPagesRaw = q.maxPages ?? q.max_pages;
      const onlyIdRaw = q.onlyId ?? q.only_id ?? q.raw;
      const onlyId =
        String(onlyIdRaw ?? '').toLowerCase() === '1' ||
        String(onlyIdRaw ?? '').toLowerCase() === 'true' ||
        String(onlyIdRaw ?? '').toLowerCase() === 'yes';

      if (!clientFullName) {
        return res
          .status(400)
          .json({ message: 'Query requerido: nombre (o clientName/clientFullName)' });
      }

      const result = await this.installationService.findWisphubTicketIdByClientFullName({
        clientFullName: String(clientFullName),
        maxPages: maxPagesRaw !== undefined ? Number(maxPagesRaw) : undefined,
      });

      if (!result.idTicket) {
        if (onlyId) {
          return res.status(404).type('text/plain').send('');
        }
        return res.status(404).json(result);
      }

      if (onlyId) {
        return res.status(200).type('text/plain').send(String(result.idTicket));
      }

      return res.status(200).json(result);
    } catch (error: any) {
      logger.error(`Error searching Wisphub ticket: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message || 'Error buscando ticket en Wisphub', data: error.data });
    }
  }

  public async listarStaffWisphub(req: Request, res: Response): Promise<Response> {
    try {
      const q: any = req.query ?? {};
      const limitRaw = q.limit;
      const offsetRaw = q.offset;

      const limit = limitRaw !== undefined && limitRaw !== null && String(limitRaw).trim() !== '' ? Number(limitRaw) : undefined;
      const offset =
        offsetRaw !== undefined && offsetRaw !== null && String(offsetRaw).trim() !== '' ? Number(offsetRaw) : undefined;

      const result = await this.installationService.listWisphubStaff({ limit, offset });
      const isOk = result.status >= 200 && result.status < 300;
      return res.status(isOk ? 200 : 502).json(result);
    } catch (error: any) {
      logger.error(`Error listing Wisphub staff: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res
        .status(statusCode)
        .json({ message: error.message || 'Error listando staff Wisphub', data: error.data });
    }
  }

  public async editarInstalacionGeonet(req: Request, res: Response): Promise<Response> {
    try {
      const { externalIdOrUser, installationId } = req.params as any;

      // Acepta body plano (fields) o { updates: { ... } }
      const body: any = req.body ?? {};
      const updates = body && typeof body === 'object' && body.updates && typeof body.updates === 'object'
        ? body.updates
        : body;

      const result = await this.installationService.editarInstalacionGeonet({
        externalIdOrUser: String(externalIdOrUser ?? ''),
        installationId: String(installationId ?? ''),
        updates: updates && typeof updates === 'object' ? updates : {},
      });

      const hasValidationErrors =
        (result.formErrors && result.formErrors.length > 0) ||
        (result.missingRequiredFields && result.missingRequiredFields.length > 0);

      const isOk = result.status >= 200 && result.status < 400;
      if (isOk && hasValidationErrors) {
        return res.status(422).json(result);
      }

      return res.status(isOk ? 200 : 502).json(result);
    } catch (error: any) {
      logger.error(`Error editing Geonet installation: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res
        .status(statusCode)
        .json({ message: error.message || 'Error editando instalación Geonet', data: error.data });
    }
  }

  public async eliminarInstalacionGeonet(req: Request, res: Response): Promise<Response> {
    try {
      const externalId = String((req.params as any).externalId ?? '').trim();
      if (!externalId) {
        return res.status(400).json({ message: 'externalId es requerido en la URL' });
      }

      const result = await this.installationService.eliminarInstalacionGeonet({ externalId });

      const isOk = result.status >= 200 && result.status < 400;
      const hasValidationErrors = result.formErrors && result.formErrors.length > 0;
      if (isOk && hasValidationErrors) {
        return res.status(422).json(result);
      }

      return res.status(isOk ? 200 : 502).json(result);
    } catch (error: any) {
      logger.error(`Error deleting Geonet installation: ${String(error)}`);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message || 'Error eliminando instalación Geonet', data: error.data });
    }
  }

}