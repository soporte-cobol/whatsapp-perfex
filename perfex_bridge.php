<?php
/**
 * Bridge de Emergencia V7 - MÁXIMA COMPATIBILIDAD
 * Ubicación recomendada: /assets/perfex_bridge.php
 */
ob_start();
header('Content-Type: application/json; charset=utf-8');
define('BASEPATH', 'index.php');

// Buscamos la carpeta config subiendo un nivel desde assets
$possible_path = dirname(__DIR__) . '/application/config/app-config.php';

if (!file_exists($possible_path)) {
    // Si no está ahí, probamos en la raíz por si acaso
    $possible_path = __DIR__ . '/application/config/app-config.php';
}

if (!file_exists($possible_path)) {
    die(json_encode(['error' => 'No se encontró app-config.php en ' . $possible_path]));
}

require_once($possible_path);

$secret_key = "EgyysBsXsJsKNj5HGWfF";
$received_token = $_GET['token'] ?? $_POST['token'] ?? '';

if (trim($received_token) !== trim($secret_key)) {
    http_response_code(401);
    die(json_encode(['error' => 'Token inválido', 'received' => $received_token]));
}

$conn = mysqli_connect(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);
if (!$conn) {
    die(json_encode(['error' => 'Error de conexión DB', 'detail' => mysqli_connect_error()]));
}

mysqli_set_charset($conn, "utf8");

$raw_body = file_get_contents('php://input');
$data_json = json_decode($raw_body, true) ?: [];
$action = $_GET['action'] ?? ($data_json['action'] ?? ($_POST['action'] ?? ''));
$response = (object)["status" => "error", "message" => "Action not found: $action"];

switch ($action) {
    case 'get_customer_by_phone':
        $phone = preg_replace('/\D/', '', $_GET['phone'] ?? '');
        $last7 = substr($phone, -7);
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.phonenumber LIKE '%$last7%' OR cl.phonenumber LIKE '%$last7%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $response = ($r = mysqli_fetch_assoc($res)) ? (object)array_merge($r, ['found' => true]) : (object)['found' => false];
        break;

    case 'get_customer_by_email':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.email = '$email' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $response = ($r = mysqli_fetch_assoc($res)) ? (object)array_merge($r, ['found' => true]) : (object)['found' => false];
        break;

    case 'get_customer_by_vat':
        $vat = mysqli_real_escape_string($conn, trim($_GET['vat'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblclients cl 
                LEFT JOIN tblcontacts c ON cl.userid = c.userid AND c.is_primary = 1 
                WHERE cl.vat LIKE '%$vat%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $response = ($r = mysqli_fetch_assoc($res)) ? (object)array_merge($r, ['found' => true]) : (object)['found' => false];
        break;

    case 'get_invoices':
        $response = [];
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT id, number, total, status, hash FROM tblinvoices WHERE clientid = $cid AND status != 2 ORDER BY date DESC LIMIT 5";
        $res = mysqli_query($conn, $sql);
        while ($row = mysqli_fetch_assoc($res)) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
            $response[] = $row;
        }
        break;

    case 'get_projects':
        $response = [];
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT name as travel_plan FROM tblprojects WHERE clientid = $cid LIMIT 3";
        $res = mysqli_query($conn, $sql);
        while ($row = mysqli_fetch_assoc($res)) $response[] = $row;
        break;

    case 'create_ticket':
        $data = count($data_json) > 0 ? $data_json : $_POST;
        $subject = mysqli_real_escape_string($conn, $data['subject'] ?? 'Consulta desde WhatsApp');
        $message = mysqli_real_escape_string($conn, $data['message'] ?? '');
        $priority = intval($data['priority'] ?? 2);
        $department = intval($data['department'] ?? 1);
        $userid = intval($data['customerId'] ?? 0);
        
        $sql = "INSERT INTO tbltickets (subject, message, priority, department, userid, date, status) 
                VALUES ('$subject', '$message', $priority, $department, $userid, '" . date('Y-m-d H:i:s') . "', 1)";
        
        if (mysqli_query($conn, $sql)) {
            $response = ['status' => 'success', 'ticket_id' => mysqli_insert_id($conn)];
        } else {
            $response = ['status' => 'error', 'message' => mysqli_error($conn)];
        }
        break;

    case 'create_customer':
        $data = (count($data_json) > 0) ? $data_json : $_POST;
        $name = mysqli_real_escape_string($conn, $data['name'] ?? 'Usuario WA');
        $email = mysqli_real_escape_string($conn, $data['email'] ?? '');
        $phone = mysqli_real_escape_string($conn, $data['phonenumber'] ?? '');
        $vat = mysqli_real_escape_string($conn, $data['vat'] ?? '');

        // 1. Crear Cliente - Espejo exacto del registro exitoso (ID Moneda 3, País 49, Bogotá, AddedFrom 1)
        $sql1 = "INSERT INTO tblclients (company, phonenumber, vat, datecreated, active, default_currency, addedfrom, country, city, billing_country, shipping_country) 
                 VALUES ('$name', '$phone', '$vat', '" . date('Y-m-d H:i:s') . "', 1, 3, 1, 49, 'Bogotá DC', 49, 49)";

        if (mysqli_query($conn, $sql1)) {
            $userid = mysqli_insert_id($conn);
            
            // Separar nombre y apellido para el contacto
            $parts = explode(' ', trim($name));
            $fname = mysqli_real_escape_string($conn, $parts[0]);
            $lname = mysqli_real_escape_string($conn, count($parts) > 1 ? implode(' ', array_slice($parts, 1)) : '');

            // 2. Crear Contacto Principal
            $sql2 = "INSERT INTO tblcontacts (userid, firstname, lastname, email, phonenumber, is_primary) 
                     VALUES ($userid, '$fname', '$lname', '$email', '$phone', 1)";
            @mysqli_query($conn, $sql2); // El @ evita que errores de duplicado rompan el JSON
            
            $response = (object)['status' => 'success', 'customerId' => $userid];
        } else {
            $response = (object)['status' => 'error', 'message' => 'MySQL Error: ' . mysqli_error($conn), 'sql' => $sql1];
        }
        break;

    case 'send_piping_email':
        $data = count($data_json) > 0 ? $data_json : $_POST;
        $to = mysqli_real_escape_string($conn, $data['to'] ?? '');
        $from = mysqli_real_escape_string($conn, $data['from_email'] ?? '');
        $subject = $data['subject'] ?? 'Nuevo Ticket WhatsApp';
        $body = $data['body'] ?? '';

        // Headers críticos para simular que el correo viene del cliente
        $headers = "From: $from\r\n";
        $headers .= "Reply-To: $from\r\n";
        $headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";
        $headers .= "MIME-Version: 1.0\r\n";
        $headers .= "Content-Type: text/plain; charset=utf-8\r\n";

        if (mail($to, $subject, $body, $headers)) {
            $response = ['status' => 'success', 'sent' => true];
        } else {
            $response = ['status' => 'error', 'message' => 'Error en función mail()'];
        }
        break;

    default:
        $response = ['status' => 'error', 'message' => 'Accion no reconocida: ' . $action];
        break;
}

// Limpieza de buffer para evitar que warnings de PHP corrompan el JSON
if (ob_get_length()) ob_clean();

// Forzamos que la respuesta sea un objeto JSON válido ({}) y no un array ([])
header('Content-Type: application/json');
echo json_encode((object)$response, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT);
mysqli_close($conn);