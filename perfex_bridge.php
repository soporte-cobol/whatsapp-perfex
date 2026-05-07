<?php
/**
 * Bridge para conectar el Bot de IA con la base de datos de Perfex
 * Subir este archivo a la raiz de Perfex CRM
 */

define('BASEPATH', 'dummy');

// Validación preventiva: Verificar si el archivo de configuración de Perfex existe
if (!file_exists(__DIR__ . '/application/config/app-config.php')) {
    http_response_code(500);
    die(json_encode([
        'error' => 'Configuración de Perfex no encontrada.',
        'detalle' => 'El archivo app-config.php no se encontró en application/config/.',
        'path' => __DIR__
    ]));
}
require_once(__DIR__ . '/application/config/app-config.php');

// Seguridad: Token para que solo tu bot pueda consultar
$secret_key = "EgyysBsXsJsKNj5HGWfF"; // <--- ESTE DEBE COINCIDIR CON PERFEX_API_TOKEN EN TU .ENV

// Seguridad Extra: Es altamente recomendable validar el origen.
// Si conoces la IP de tu servidor Node, descomenta las siguientes líneas:
// $allowed_ips = ['127.0.0.1', 'IP_DE_TU_SERVIDOR_NODE']; 
// if (!in_array($_SERVER['REMOTE_ADDR'], $allowed_ips)) {
//     http_response_code(403);
//     exit(json_encode(['error' => 'IP no autorizada']));
// }

header('Content-Type: application/json');

// Obtener el token de autorización de forma más robusta para diversos entornos
$auth_header = '';

if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $auth_header = $_SERVER['HTTP_AUTHORIZATION'];
} elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
    $auth_header = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
} elseif (function_exists('apache_request_headers')) {
    $headers = apache_request_headers();
    $auth_header = $headers['Authorization'] ?? $headers['authorization'] ?? $auth_header;
}

// Fallback: Obtener el token desde la URL si Apache eliminó el encabezado Authorization
if (empty($auth_header) && isset($_GET['token'])) {
    $auth_header = $_GET['token'];
}

// Limpieza: Eliminar prefijo "Bearer " si existe y quitar espacios
$auth_header = trim((string)$auth_header);
if (stripos($auth_header, 'Bearer ') === 0) {
    $auth_header = trim(substr($auth_header, 7));
}

$clean_secret = trim((string)$secret_key);

if (empty($auth_header) || $auth_header !== $clean_secret) {
    // Log detallado para soporte técnico
    error_log("❌ PERFEX BRIDGE AUTH ERROR: Recibido [" . ($auth_header ?: 'VACIO') . "] | Esperado [" . $clean_secret . "] | IP: " . $_SERVER['REMOTE_ADDR'] . " | UA: " . ($_SERVER['HTTP_USER_AGENT'] ?? 'N/A'));
    
    http_response_code(401);
    echo json_encode(['error' => 'No autorizado', 'debug' => 'Token mismatch']);
    exit;
}

$mysqli = new mysqli(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);

if ($mysqli->connect_error) {
    die(json_encode(['error' => 'Fallo de conexión']));
}

$action = $_GET['action'] ?? '';
// Sanitización básica de la acción
$action = htmlspecialchars($action, ENT_QUOTES, 'UTF-8');
$customer_id = isset($_GET['customer_id']) ? intval($_GET['customer_id']) : 0;
$email = $_GET['email'] ?? '';
$phone = $_GET['phone'] ?? '';
$vat = $_GET['vat'] ?? '';

$response = [];

switch ($action) {
    case 'get_customer_by_phone':
        // Buscamos en tblcontacts ya que allí residen los teléfonos de los contactos individuales
        // Limpiamos el teléfono de caracteres no numéricos para una búsqueda más flexible
        $cleanPhone = preg_replace('/[^0-9]/', '', $phone);
        
        // Si el número es largo (ej: 12 dígitos como 573001234567), 
        // extraemos los últimos 10 para evitar problemas con el prefijo internacional
        $searchNumber = (strlen($cleanPhone) >= 10) ? substr($cleanPhone, -10) : $cleanPhone;
        if (empty($searchNumber)) { 
            $response = ['found' => false, 'error' => 'Teléfono vacío']; 
            break; 
        }
        $likePhone = "%" . $searchNumber; // Buscamos que el número termine en estos dígitos
        
        $stmt = $mysqli->prepare("
            SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
            FROM tblcontacts c 
            JOIN tblclients cl ON c.userid = cl.userid 
            WHERE c.phonenumber LIKE ? OR cl.phonenumber LIKE ? LIMIT 1");
        $stmt->bind_param("ss", $likePhone, $likePhone);
        $stmt->execute();
        $result = $stmt->get_result()->fetch_assoc();
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false, 'error' => 'Cliente no encontrado'];
        break;

    case 'get_customer_by_email':
        $cleanEmail = strtolower(trim($email));
        $stmt = $mysqli->prepare("
            SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
            FROM tblcontacts c 
            JOIN tblclients cl ON c.userid = cl.userid 
            WHERE LOWER(c.email) = LOWER(?) ORDER BY c.is_primary DESC, c.id DESC LIMIT 1");
        $stmt->bind_param("s", $cleanEmail);
        $stmt->execute();
        $result = $stmt->get_result()->fetch_assoc();
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false, 'error' => 'Cliente no encontrado'];
        break;

    case 'get_customer_by_vat':
        $stmt = $mysqli->prepare("SELECT userid as customerId, company FROM tblclients WHERE vat = ? LIMIT 1");
        $stmt->bind_param("s", $vat);
        $stmt->execute();
        $client = $stmt->get_result()->fetch_assoc();
        
        if ($client) {
            // Buscamos el contacto principal para que el ticket quede bien asignado
            $stmt_contact = $mysqli->prepare("SELECT id as contactId, firstname, lastname FROM tblcontacts WHERE userid = ? AND is_primary = 1 LIMIT 1");
            $stmt_contact->bind_param("i", $client['customerId']);
            $stmt_contact->execute();
            $contact = $stmt_contact->get_result()->fetch_assoc();
            
            // FALLBACK: Si no hay un contacto marcado como principal, tomamos el primero que encontremos
            if (!$contact) {
                $stmt_fallback = $mysqli->prepare("SELECT id as contactId, firstname, lastname FROM tblcontacts WHERE userid = ? ORDER BY id ASC LIMIT 1");
                $stmt_fallback->bind_param("i", $client['customerId']);
                $stmt_fallback->execute();
                $contact = $stmt_fallback->get_result()->fetch_assoc();
            }
            
            $response = array_merge($client, $contact ? $contact : [], ['found' => true]);
        } else {
            $response = ['found' => false, 'error' => 'Cliente no encontrado'];
        }
        break;

    case 'get_invoices':
        $stmt = $mysqli->prepare("
            SELECT id, number, total, date, duedate, status, hash,
            CASE 
                WHEN status = 1 THEN 'Por pagar'
                WHEN status = 2 THEN 'Pagada'
                WHEN status = 3 THEN 'Parcialmente pagada'
                WHEN status = 4 THEN 'Vencida'
                WHEN status = 5 THEN 'Cancelada'
                WHEN status = 6 THEN 'Borrador'
                ELSE 'Desconocido'
            END as status_name
            FROM tblinvoices WHERE clientid = ? ORDER BY date DESC");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        foreach ($rows as &$row) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
        }
        $response = $rows;
        break;

    case 'get_projects':
        $stmt = $mysqli->prepare("SELECT id, name, start_date, deadline, status FROM tblprojects WHERE clientid = ?");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'get_tickets':
        $stmt = $mysqli->prepare("SELECT ticketid, subject, message, status, date FROM tbltickets WHERE email = ?");
        $stmt->bind_param("s", $email);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'get_estimates':
        $stmt = $mysqli->prepare("SELECT id, number, total, date, expirydate, status FROM tblestimates WHERE clientid = ?");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'get_proposals':
        $stmt = $mysqli->prepare("SELECT id, subject, total, date, open_till, status FROM tblproposals WHERE rel_id = ? AND rel_type = 'customer'");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'create_ticket':
        $data = json_decode(file_get_contents('php://input'), true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            http_response_code(400);
            echo json_encode(['error' => 'JSON inválido']);
            exit;
        }
        $subject = $data['subject'] ?? 'Ticket desde WhatsApp';
        $message = $data['message'] ?? '';
        $userid = $data['customerId'] ?? 0;
        $contactid = $data['contactId'] ?? 0;
        $priority = $data['priority'] ?? 1; // 1: Baja, 2: Media, 3: Alta
        
        // Corregimos la consulta para que acepte el parámetro de prioridad
        $stmt = $mysqli->prepare("INSERT INTO tbltickets (subject, message, userid, contactid, department, priority, status, date) VALUES (?, ?, ?, ?, 1, ?, 1, NOW())");
        $stmt->bind_param("ssiii", $subject, $message, $userid, $contactid, $priority);
        
        if ($stmt->execute()) {
            $ticketid = $stmt->insert_id;
            $response = ['success' => true, 'ticketid' => $ticketid];
        } else {
            $response = ['error' => 'Error al crear el ticket'];
        }
        break;

    case 'create_contact':
        $data = json_decode(file_get_contents('php://input'), true);
        $firstname = $data['firstname'] ?? '';
        $lastname = $data['lastname'] ?? '';
        $email = $data['email'] ?? '';
        $userid = $data['customerId'] ?? 0;
        $phone = $data['phone'] ?? '';

        // Insertar nuevo contacto
        $stmt = $mysqli->prepare("INSERT INTO tblcontacts (firstname, lastname, email, userid, phonenumber, datecreated) VALUES (?, ?, ?, ?, ?, NOW())");
        $stmt->bind_param("sssis", $firstname, $lastname, $email, $userid, $phone);

        if ($stmt->execute()) {
            $response = ['success' => true, 'contactId' => $stmt->insert_id];
        } else {
            $response = ['error' => 'Error al crear el contacto'];
        }
        break;

    default:
        $response = ['error' => 'Acción no válida'];
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
$mysqli->close();